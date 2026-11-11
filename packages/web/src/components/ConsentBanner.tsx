import { tracker } from '../tracker';

export function ConsentBanner() {
  return (
    <div className="consent-banner">
      <div>
        <strong>隐私授权</strong>
        <p>
          我们仅在你同意后采集页面行为事件。同意前的操作不会被缓存或补发；你可以随时在调试台撤回同意，
          撤回后立即停止采集与重试并清空本地待发队列。手机号、邮箱与表单自由文本会按规则脱敏或删除。
        </p>
      </div>
      <div className="consent-actions">
        <button className="btn primary" onClick={() => tracker.grantConsent()}>
          同意采集
        </button>
        <button className="btn" onClick={() => tracker.withdrawConsent()}>
          不同意
        </button>
      </div>
    </div>
  );
}
