import RuleCap from "./ornaments/RuleCap.jsx";

// Titled group of a creator tab: Cinzel subtitle with the gold rule (filete) under it, then the control.
// `id` names the group (the control points to it with aria-labelledby); `help` is linked by `helpId`.
export default function Group({ id, title, help, helpId, children }) {
  return (
    <div className="group">
      <h2 className="group-title" id={id}>
        {title}
        <span className="group-rule" aria-hidden="true"><RuleCap /><RuleCap /></span>
      </h2>
      {children}
      {help && <p className="group-help" id={helpId}>{help}</p>}
    </div>
  );
}
