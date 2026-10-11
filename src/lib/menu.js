// Floating context menu with one level of drill-down (submenus replace the content).
// Item: { icon, img, label, danger, check, onClick, submenu: () => Promise<items> } | { sep: true }
import { esc } from "./ui.js";

let current = null;

export function closeMenu() {
  if (!current) return;
  const el = current;
  current = null;
  el.classList.remove("in");
  setTimeout(() => el.remove(), 150);
}

/**
 * @param pos { x, y, flipY? } — viewport point; if the menu overflows the bottom it opens
 *            upward from `flipY` (or `y`).
 * @param items array of items, or a promise of one (shows a spinner meanwhile).
 */
export function openMenu(pos, items) {
  closeMenu();
  const el = document.createElement("div");
  el.className = "menu";
  el.setAttribute("role", "menu");
  document.body.append(el);
  current = el;
  const stack = [];
  let shown = [];

  const place = () => {
    const w = el.offsetWidth, h = el.offsetHeight;
    const left = Math.max(8, Math.min(pos.x, innerWidth - w - 8));
    let top = pos.y;
    if (top + h > innerHeight - 8) top = Math.max(8, (pos.flipY ?? pos.y) - h);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  };

  const show = (list) => {
    shown = list;
    el.innerHTML = list.length
      ? list
          .map((it, i) => {
            if (it.sep) return '<div class="menu-sep"></div>';
            const lead = it.img
              ? `<img src="${esc(it.img)}" alt="" />`
              : it.img === "" ? '<span class="menu-thumb"><i class="ph ph-playlist"></i></span>'
              : it.icon ? `<i class="ph ${it.icon}"></i>` : "";
            const role = it.check != null ? `menuitemcheckbox" aria-checked="${!!it.check}` : "menuitem";
            return `<button class="menu-item${it.danger ? " danger" : ""}${it.back ? " back" : ""}" data-mi="${i}" role="${role}">
              ${lead}<span>${esc(it.label)}</span>${it.check ? '<i class="ph-bold ph-check check"></i>' : ""}${it.submenu ? '<i class="ph ph-caret-right sub"></i>' : ""}</button>`;
          })
          .join("")
      : '<div class="menu-empty">Пусто</div>';
    place();
  };

  const load = async (promise, header) => {
    el.innerHTML = '<div class="menu-loading"><div class="spinner"></div></div>';
    place();
    try {
      const list = await promise;
      if (current !== el) return;
      show(header ? [header, { sep: true }, ...list] : list);
    } catch (e) {
      if (current !== el) return;
      el.innerHTML = `<div class="menu-empty">Ошибка: ${esc(e?.message || e)}</div>`;
    }
  };

  el.addEventListener("click", (e) => {
    const b = e.target.closest("[data-mi]");
    if (!b) return;
    const it = shown[+b.dataset.mi];
    if (it.back) return show(stack.pop());
    if (it.submenu) {
      stack.push(shown);
      return load(it.submenu(), { icon: "ph-arrow-left", label: it.label, back: true });
    }
    closeMenu();
    it.onClick?.();
  });

  Array.isArray(items) ? show(items) : load(items);
  requestAnimationFrame(() => el.classList.add("in"));
}

document.addEventListener("pointerdown", (e) => current && !current.contains(e.target) && closeMenu(), true);
document.addEventListener("keydown", (e) => e.key === "Escape" && closeMenu());
window.addEventListener("blur", closeMenu);
window.addEventListener("resize", closeMenu);
document.addEventListener("scroll", (e) => current && !current.contains(e.target) && closeMenu(), true);
