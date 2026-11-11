import { useMemo, useState } from 'react';
import { PRODUCTS, type Product } from '../data';
import { tracker } from '../tracker';
import { useConsent } from '../hooks';

interface CartLine {
  product: Product;
  qty: number;
}

export function ProductPage() {
  const consent = useConsent();
  const [keyword, setKeyword] = useState('');
  const [category, setCategory] = useState('全部');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');

  const categories = useMemo(() => ['全部', ...new Set(PRODUCTS.map((p) => p.category))], []);
  const results = useMemo(
    () =>
      PRODUCTS.filter(
        (p) =>
          (category === '全部' || p.category === category) &&
          (keyword.trim() === '' || p.name.includes(keyword) || p.desc.includes(keyword)),
      ),
    [keyword, category],
  );

  function doSearch() {
    void tracker.track({
      event_type: 'search',
      properties: {
        // 自由文本：若包含手机号/邮箱会被脱敏；同时附带白名单外字段演示逐层删除
        keyword,
        result_count: results.length,
        filters: {
          category,
          max_price: 9999,
          tags: ['促销', keyword],
          secret_internal_field: 'should-be-dropped',
        },
        rogue_top_level: 'not-in-whitelist',
      },
    });
  }

  function clickProduct(p: Product, ev: React.MouseEvent) {
    void tracker.track({
      event_type: 'click',
      properties: {
        element_id: `product-card-${p.id}`,
        element_text: `${p.name} ${p.desc} 联系13800138000`, // 内嵌手机号的自由文本
        position: { x: Math.round(ev.clientX), y: Math.round(ev.clientY), screen: 'main' },
      },
    });
  }

  function addToCart(p: Product) {
    setCart((prev) => {
      const found = prev.find((l) => l.product.id === p.id);
      return found
        ? prev.map((l) => (l.product.id === p.id ? { ...l, qty: l.qty + 1 } : l))
        : [...prev, { product: p, qty: 1 }];
    });
    void tracker.track({
      event_type: 'add_to_cart',
      properties: {
        product_id: p.id,
        product_name: p.name,
        price: p.price,
        quantity: 1,
        meta: {
          source: 'search_list',
          campaign: 'double11',
          extra: { note: `加急配送，联系邮箱 test@example.com`, injected: 'drop-me' },
        },
      },
    });
  }

  function subscribe(ev: React.FormEvent) {
    ev.preventDefault();
    void tracker.track({
      event_type: 'subscribe',
      properties: {
        channel: 'sms+email',
        phone, // 手机号字段
        email, // 邮箱字段
        message, // 自由文本
        debug_field: 123, // 白名单外，应删除
      },
    });
    setMessage('订阅请求已记录（查看调试台确认字段处理结果）');
  }

  return (
    <div className="product-page">
      {consent !== 'granted' && (
        <div className="notice">🔒 当前未授权采集，本页操作不会产生事件（也不会缓存补发）。</div>
      )}

      <section className="panel">
        <h2>商品搜索</h2>
        <div className="search-row">
          <input
            placeholder="搜索商品名称/描述（可输入含手机号 13800138000 的文本测试脱敏）"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && doSearch()}
          />
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            {categories.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <button className="btn primary" onClick={doSearch} disabled={consent !== 'granted'}>
            搜索
          </button>
        </div>
      </section>

      <section className="panel">
        <h2>商品列表（点击卡片 / 加入购物车都会产生真实事件）</h2>
        <div className="grid">
          {results.map((p) => (
            <article
              key={p.id}
              id={`product-card-${p.id}`}
              className="product-card"
              onClick={(ev) => clickProduct(p, ev)}
            >
              <h3>{p.name}</h3>
              <p className="muted">{p.desc}</p>
              <p className="price">¥{p.price}</p>
              <button
                className="btn primary"
                disabled={consent !== 'granted'}
                onClick={(ev) => {
                  ev.stopPropagation();
                  addToCart(p);
                }}
              >
                加入购物车
              </button>
            </article>
          ))}
        </div>
      </section>

      <section className="panel two-col">
        <div>
          <h2>购物车（{cart.reduce((s, l) => s + l.qty, 0)} 件）</h2>
          {cart.length === 0 && <p className="muted">还没有商品</p>}
          <ul className="cart-list">
            {cart.map((l) => (
              <li key={l.product.id}>
                {l.product.name} × {l.qty} <span>¥{l.product.price * l.qty}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h2>到货通知订阅（PII 字段测试）</h2>
          <form onSubmit={subscribe} className="subscribe-form">
            <input
              placeholder="手机号，如 13800138000"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              disabled={consent !== 'granted'}
            />
            <input
              placeholder="邮箱，如 zhangsan@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={consent !== 'granted'}
            />
            <textarea
              placeholder="留言（自由文本，试试写手机号/邮箱进去）"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
              disabled={consent !== 'granted'}
            />
            <button className="btn primary" disabled={consent !== 'granted'}>
              提交订阅
            </button>
          </form>
        </div>
      </section>
    </div>
  );
}
