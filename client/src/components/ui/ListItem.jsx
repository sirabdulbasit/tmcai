import './ui.css';

/**
 * ListItem — generic row used in wiki list, approvals, custom actions.
 *
 *   <ListItem active={isSelected} onClick={...}>
 *     <ListItem.Title>My page</ListItem.Title>
 *     <ListItem.Meta>entity · 12 sources · 2d ago</ListItem.Meta>
 *   </ListItem>
 */
export default function ListItem({ active = false, onClick, children, right, className = '' }) {
  const cls = ['ui-list-item', active && 'active', className].filter(Boolean).join(' ');
  return (
    <div className={cls} onClick={onClick} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined}>
      <div className="ui-list-item-body">{children}</div>
      {right && <div>{right}</div>}
    </div>
  );
}

ListItem.Title = function Title({ children, className = '' }) {
  return <div className={`ui-list-item-title ${className}`}>{children}</div>;
};
ListItem.Meta = function Meta({ children, className = '' }) {
  return <div className={`ui-list-item-meta ${className}`}>{children}</div>;
};
