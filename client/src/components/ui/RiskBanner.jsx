import './ui.css';

/**
 * RiskBanner — inline banner for risk tier (LOW / MEDIUM / HIGH).
 */
export default function RiskBanner({ tier = 'low', children, className = '' }) {
  const t = tier.toLowerCase();
  const norm = t === 'med' ? 'medium' : t;
  return (
    <div className={`ui-risk-banner ui-risk-${norm} ${className}`}>
      {children}
    </div>
  );
}
