import './ui.css';

/**
 * Rail — left-edge vertical icon navigation, grouped.
 *
 *   <Rail>
 *     <RailLogo onClick={...} />
 *     <RailSection>
 *       <RailButton active label="Brain Query" onClick={...}><Icon/></RailButton>
 *       ...
 *     </RailSection>
 *     <RailSpacer />
 *     <RailSection>...ops...</RailSection>
 *   </Rail>
 */
export default function Rail({ children, className = '' }) {
  return <aside className={`ui-rail ${className}`}>{children}</aside>;
}

export function RailLogo({ src, onClick }) {
  return (
    <button type="button" className="ui-rail-logo" onClick={onClick} aria-label="Home">
      {src && <img src={src} alt="" style={{ width: '100%', height: '100%', borderRadius: 'inherit' }} />}
    </button>
  );
}

export function RailSection({ children }) {
  return <div className="ui-rail-section">{children}</div>;
}

export function RailSpacer() {
  return <div className="ui-rail-spacer" />;
}

export function RailButton({ active = false, label, onClick, children }) {
  // Note: no `title` attribute — that triggers the browser's native
  // OS-styled tooltip on top of our themed one (~1s after the styled
  // one already slid in), which looks like two tooltips. We rely on
  // the CSS .ui-rail-tooltip span for the visual and aria-label for a11y.
  return (
    <button
      type="button"
      className={`ui-rail-btn ${active ? 'active' : ''}`}
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
    >
      {children}
      {label && <span className="ui-rail-tooltip">{label}</span>}
    </button>
  );
}
