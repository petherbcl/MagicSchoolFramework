import { useEffect } from "react";
import { categoryIcon } from "./icons/categoryIcons.js";

export const tabId = key => `tab-${key}`;
export const panelId = key => `panel-${key}`;

// Circular category tabs with the Q / E keycaps at the ends (handoff §4.3, §6, §8; creator.html).
// WAI-ARIA tabs with automatic activation: ←/→/Home/End inside the tablist, no wrap. The keycaps are real buttons
// with a 44 px hit area but outside the Tab order (Q/E are handled globally by the creator).
//   tabs        [{ key, label, icon }]
//   activeKey   key of the active tab (the others have tabindex -1)
//   onSelect    (key, { focus }) the player activated a tab; `focus` when the keyboard moved it
//   onStep      (direction) the Q / E keycap was clicked
//   disabled    a request is in flight
export default function CreatorTabs({ tabs, activeKey, onSelect, onStep, disabled = false }) {
  const index = Math.max(0, tabs.findIndex(tab => tab.key === activeKey));

  // The active tab stays visible when the bar scrolls (1280x720).
  useEffect(() => { document.getElementById(tabId(activeKey))?.scrollIntoView?.({ block: "nearest", inline: "nearest" }); }, [activeKey]);

  const onKeyDown = event => {
    const current = tabs.findIndex(tab => tab.key === document.activeElement?.dataset.tab);
    if (current < 0 || disabled) return;
    const target = { ArrowLeft: current - 1, ArrowRight: current + 1, Home: 0, End: tabs.length - 1 }[event.key];
    if (target === undefined) return;
    event.preventDefault();
    const next = tabs[Math.min(tabs.length - 1, Math.max(0, target))];
    onSelect(next.key, { focus: true });
  };

  return (
    <div className="tabbar">
      <button type="button" className="keycap tabbar__key hint--button" tabIndex={-1} aria-label="Separador anterior (Q)"
        aria-disabled={disabled || index === 0 || undefined} onClick={() => onStep(-1)}>Q</button>
      <div className="tabs" role="tablist" aria-label="Categorias de aparência" onKeyDown={onKeyDown}>
        {tabs.map(tab => {
          const Icon = categoryIcon(tab.icon);
          const selected = tab.key === tabs[index].key;
          return (
            <button key={tab.key} type="button" role="tab" className="tab" id={tabId(tab.key)} data-tab={tab.key}
              aria-controls={panelId(tab.key)} aria-selected={selected} tabIndex={selected ? 0 : -1} aria-label={tab.label}
              onClick={() => { if (!disabled) onSelect(tab.key, { focus: false }); }}>
              <Icon />
              <span className="tab__tip" aria-hidden="true">{tab.label}</span>
            </button>
          );
        })}
      </div>
      <button type="button" className="keycap tabbar__key hint--button" tabIndex={-1} aria-label="Separador seguinte (E)"
        aria-disabled={disabled || index === tabs.length - 1 || undefined} onClick={() => onStep(1)}>E</button>
    </div>
  );
}
