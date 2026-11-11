import type { DeadletterEntry, QueuedEvent } from './types.js';

/**
 * IndexedDB 持久层。
 * 只暂存「已经过滤」的事件；死信单独存放，不再参与重试。
 */

const DB_NAME = 'pointwise-sdk-db';
const DB_VERSION = 1;
const STORE_QUEUE = 'event_queue';
const STORE_DEAD = 'deadletter';

export class EventStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_QUEUE)) {
          // keyPath 为 event_id：天然去重，重试始终覆盖同一条
          db.createObjectStore(STORE_QUEUE, { keyPath: 'event_id' });
        }
        if (!db.objectStoreNames.contains(STORE_DEAD)) {
          db.createObjectStore(STORE_DEAD, { keyPath: 'event_id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.dbPromise;
  }

  private async tx<T>(
    storeName: string,
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const req = fn(tx.objectStore(storeName));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async putQueued(event: QueuedEvent): Promise<void> {
    await this.tx(STORE_QUEUE, 'readwrite', (s) => s.put(event));
  }

  async getQueued(ids: string[]): Promise<QueuedEvent[]> {
    const all = await this.allQueued();
    const set = new Set(ids);
    return all.filter((e) => set.has(e.event_id));
  }

  async allQueued(): Promise<QueuedEvent[]> {
    return this.tx(STORE_QUEUE, 'readonly', (s) => s.getAll() as IDBRequest<QueuedEvent[]>);
  }

  async deleteQueued(ids: string[]): Promise<void> {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_QUEUE, 'readwrite');
      const store = tx.objectStore(STORE_QUEUE);
      for (const id of ids) store.delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async queueSize(): Promise<number> {
    return this.tx(STORE_QUEUE, 'readonly', (s) => s.count());
  }

  async putDead(entry: DeadletterEntry): Promise<void> {
    await this.tx(STORE_DEAD, 'readwrite', (s) => s.put(entry));
  }

  async allDead(): Promise<DeadletterEntry[]> {
    return this.tx(STORE_DEAD, 'readonly', (s) => s.getAll() as IDBRequest<DeadletterEntry[]>);
  }

  async clearQueue(): Promise<void> {
    await this.tx(STORE_QUEUE, 'readwrite', (s) => s.clear());
  }

  async clearDead(): Promise<void> {
    await this.tx(STORE_DEAD, 'readwrite', (s) => s.clear());
  }
}
