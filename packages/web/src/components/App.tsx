import { useState } from 'react';
import { ConsentBanner } from './ConsentBanner';
import { ProductPage } from './ProductPage';
import { DebugConsole } from './DebugConsole';
import { useConsent } from '../hooks';

type Tab = 'product' | 'debug';

export function App() {
  const [tab, setTab] = useState<Tab>('product');
  const consent = useConsent();

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">📊 Pointwise 埋点演示</div>
        <nav className="tabs">
          <button className={tab === 'product' ? 'tab active' : 'tab'} onClick={() => setTab('product')}>
            演示商品页
          </button>
          <button className={tab === 'debug' ? 'tab active' : 'tab'} onClick={() => setTab('debug')}>
            调试台
          </button>
        </nav>
        <span className={`consent-pill consent-${consent}`}>
          同意状态：{consent === 'granted' ? '已同意' : consent === 'denied' ? '已撤回' : '未决定'}
        </span>
      </header>

      {consent === 'unknown' && <ConsentBanner />}

      <main className="content">{tab === 'product' ? <ProductPage /> : <DebugConsole />}</main>
    </div>
  );
}
