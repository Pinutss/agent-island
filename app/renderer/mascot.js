// Built from agent-flow/hooks/mascot.ts (the Agent Flow mod's mascots); rebuild rather than edit.

// ../../agent-flow/hooks/board.ts
var SKINS = [
  { name: "Classique", body: "#D97757", dark: "#A8553A" },
  { name: "Explorateur", body: "#2FA89B", dark: "#1F7A70" },
  { name: "Mage", body: "#8C6FE0", dark: "#6247B8" },
  { name: "B\xE2tisseur", body: "#E3A72F", dark: "#B07D14" },
  { name: "DJ", body: "#E86AA6", dark: "#B9437C" },
  { name: "Monarque", body: "#4F8EF7", dark: "#2F66C4" },
  { name: "Ninja", body: "#7D8BA3", dark: "#4C586B" },
  { name: "Chef", body: "#3EBE7B", dark: "#25905A" },
  { name: "Pirate", body: "#E0584E", dark: "#AE3A32" },
  { name: "Inventeur", body: "#38BDF8", dark: "#1B8DC0" }
];
function skinOf(index) {
  return SKINS[index] ?? SKINS[0];
}
function isLive(phase) {
  return phase === "starting" || phase === "thinking" || phase === "tool";
}

// ../../agent-flow/hooks/mascot.ts
var INK = "#2A1A12";
function frame(width, height) {
  return `width="${width}" height="${height}" style="display:block"`;
}
function sparkle(cx, cy, r) {
  return `M${cx} ${cy - r}Q${cx} ${cy} ${cx + r} ${cy}Q${cx} ${cy} ${cx} ${cy + r}Q${cx} ${cy} ${cx - r} ${cy}Q${cx} ${cy} ${cx} ${cy - r}Z`;
}
function star(cx, cy, r) {
  const points = [];
  for (let i = 0; i < 10; i++) {
    const radius = i % 2 === 0 ? r : r * 0.45;
    const angle = -Math.PI / 2 + i * Math.PI / 5;
    points.push(`${(cx + radius * Math.cos(angle)).toFixed(1)},${(cy + radius * Math.sin(angle)).toFixed(1)}`);
  }
  return points.join(" ");
}
var CSS = `
html,body{margin:0;padding:0;overflow:hidden;background:transparent}
svg{--shadow:rgba(70,45,20,.14);--ok:#22a06b;--err:#e5484d;--muted:#8a847b}
@media (prefers-color-scheme:dark){svg{--shadow:rgba(0,0,0,.45);--ok:#3dd68c;--err:#ff6369;--muted:#a8a29a}}
.shadow{fill:var(--shadow)}.mu{fill:var(--muted)}
.spin,.blink,.pop,.prop,.tw{transform-box:fill-box;transform-origin:center}
.sway,.br,.hop{transform-box:fill-box;transform-origin:50% 100%}
.gray{filter:grayscale(.85);opacity:.75}
@keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-2.5px)}}.bob{animation:bob .9s ease-in-out infinite}
@keyframes legA{0%,100%{transform:translateY(0)}50%{transform:translateY(-2px)}}
@keyframes legB{0%,100%{transform:translateY(-2px)}50%{transform:translateY(0)}}
.legA{animation:legA .36s steps(2) infinite}.legB{animation:legB .36s steps(2) infinite}
@keyframes armL{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}
@keyframes armR{0%,100%{transform:translateY(-3px)}50%{transform:translateY(0)}}
.armL{animation:armL .26s steps(2) infinite}.armR{animation:armR .26s steps(2) infinite}
@keyframes blink{0%,93%,100%{transform:scaleY(1)}96%{transform:scaleY(.1)}}.blink{animation:blink 3.6s infinite}
@keyframes br{0%,100%{transform:scaleY(1)}50%{transform:scaleY(.965)}}.br{animation:br 3.2s ease-in-out infinite}
@keyframes sway{0%,100%{transform:rotate(-9deg)}50%{transform:rotate(9deg)}}.sway{animation:sway 1.7s ease-in-out infinite}
@keyframes prop{0%,100%{transform:scaleX(1)}50%{transform:scaleX(-1)}}.prop{animation:prop .28s linear infinite}
@keyframes tw{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.65)}}.tw{animation:tw 1.5s ease-in-out infinite}
@keyframes flap{0%,100%{transform:skewY(0)}50%{transform:skewY(-12deg)}}.flap{transform-box:fill-box;transform-origin:0 50%;animation:flap .5s ease-in-out infinite}
@keyframes sp1{0%{opacity:0;transform:translate(0,0) scale(.5)}25%{opacity:1}100%{opacity:0;transform:translate(5px,-15px) scale(1.1)}}
@keyframes sp2{0%{opacity:0;transform:translate(0,0) scale(.5)}30%{opacity:1}100%{opacity:0;transform:translate(-7px,-13px) scale(1)}}
@keyframes sp3{0%{opacity:0;transform:translate(0,0) scale(.5)}20%{opacity:1}100%{opacity:0;transform:translate(10px,-8px) scale(.9)}}
.sp1{animation:sp1 1.1s ease-out infinite}.sp2{animation:sp2 1.45s ease-out infinite}.sp3{animation:sp3 1.8s ease-out infinite}
@keyframes note{0%{opacity:0;transform:translate(0,0)}25%{opacity:1}100%{opacity:0;transform:translate(7px,-14px)}}
.note{animation:note 1.6s ease-out infinite}.note2{animation:note 2.1s ease-out infinite}
@keyframes zz{0%{opacity:0;transform:translate(0,0) scale(.6)}30%{opacity:1}100%{opacity:0;transform:translate(9px,-16px) scale(1.15)}}
.zz1{animation:zz 2.4s ease-out infinite}.zz2{animation:zz 3.1s ease-out infinite}
@keyframes rot{to{transform:rotate(360deg)}}.spin{animation:rot 3s linear infinite}.spinS{animation:rot 14s linear infinite}
@keyframes pop{0%{transform:scale(0)}60%{transform:scale(1.3)}100%{transform:scale(1)}}.pop{animation:pop .55s cubic-bezier(.2,.8,.2,1) both}
@keyframes hop{0%,100%{transform:translateY(0)}40%{transform:translateY(-7px)}}.hop{animation:hop .55s ease-out 2 both}
@keyframes shake{0%,100%{transform:translateX(0)}20%,60%{transform:translateX(-2.5px)}40%,80%{transform:translateX(2.5px)}}.shake{animation:shake .45s 2 both}
`;
function eyes(mood) {
  switch (mood) {
    case "done":
      return `<path d="M10.5 22L14 17.5L17.5 22M26.5 22L30 17.5L33.5 22" stroke="${INK}" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
    case "fail":
      return `<path d="M11 16.5l6 6m0-6l-6 6M27 16.5l6 6m0-6l-6 6" stroke="${INK}" stroke-width="2.4" stroke-linecap="round"/>`;
    case "sleep":
      return `<path d="M11 21h6M27 21h6" stroke="${INK}" stroke-width="2.4" stroke-linecap="round"/>`;
    default:
      return `<g class="blink"><rect x="12" y="16" width="4" height="8" fill="${INK}"/><rect x="28" y="16" width="4" height="8" fill="${INK}"/></g>`;
  }
}
function accessory(skin, mood) {
  const moving = mood === "work";
  switch (skin) {
    case -1:
      return `<path d="M5 14Q5 1 22 1Q39 1 39 14" stroke="#2B2B33" stroke-width="2.4" fill="none"/><rect x="2" y="12" width="5" height="9" rx="2" fill="#2B2B33"/><rect x="37" y="12" width="5" height="9" rx="2" fill="#2B2B33"/><path d="M4.5 21Q6 29 13 28.5" stroke="#2B2B33" stroke-width="1.6" fill="none"/><circle cx="14" cy="28.5" r="2" fill="#2B2B33"/><path class="tw" d="${sparkle(22, -3, 4)}" fill="#F5B66B"/>`;
    case 0:
      return `<g class="sway"><path d="M22 12V5" stroke="#3E9B4F" stroke-width="2" stroke-linecap="round"/><ellipse cx="18.2" cy="5.2" rx="4.2" ry="2.2" fill="#5CC46E"/><ellipse cx="25.8" cy="4.2" rx="4.2" ry="2.2" fill="#4DB55F"/></g>`;
    case 1:
      return `<path d="M9 10Q9 1 22 1Q35 1 35 10Z" fill="#D8BC85"/><rect x="9" y="6.5" width="26" height="2.6" fill="#7A5C34"/><rect x="1" y="9.5" width="42" height="3.5" rx="1.75" fill="#C4A267"/>`;
    case 2:
      return `<path d="M7 13L37 13L25 -15Z" fill="#4C3A99"/><path d="M5 13H39" stroke="#3A2C78" stroke-width="3" stroke-linecap="round"/><polygon class="tw" points="${star(23, 1, 4.2)}" fill="#FFD84D"/><circle class="tw" cx="16" cy="8" r="1" fill="#FFE98A"/>`;
    case 3:
      return `<path d="M8 12Q8 1 22 1Q36 1 36 12Z" fill="#FFC21A"/><rect x="20" y="1.5" width="4" height="10" fill="#FFE07A"/><rect x="4" y="10" width="36" height="3.5" rx="1.75" fill="#E6A800"/>`;
    case 4:
      return `<path d="M3 16Q3 -2 22 -2Q41 -2 41 16" stroke="#2B2B33" stroke-width="3" fill="none"/><rect x="-1.5" y="12" width="7" height="12" rx="3" fill="#2B2B33"/><rect x="38.5" y="12" width="7" height="12" rx="3" fill="#2B2B33"/><circle class="tw" cx="2" cy="18" r="1.6" fill="#FF6FB0"/>${moving ? `<text class="note" x="44" y="8" font-size="10" fill="#E86AA6">\u266A</text><text class="note2" x="-8" y="6" font-size="9" fill="#8C6FE0">\u266B</text>` : ""}`;
    case 5:
      return `<path d="M8 12L8 2L14 7L22 -1L30 7L36 2L36 12Z" fill="#FFCC33" stroke="#D9A21B" stroke-width="1" stroke-linejoin="round"/><circle cx="22" cy="6.5" r="1.9" fill="#E5484D"/><circle cx="13.5" cy="9.5" r="1.3" fill="#3EA6FF"/><circle cx="30.5" cy="9.5" r="1.3" fill="#3EA6FF"/><path class="tw" d="${sparkle(38, -1, 3)}" fill="#FFE98A"/>`;
    case 6:
      return `<rect x="4" y="12" width="36" height="4" fill="#C0392B"/><g class="flap"><path d="M40 13.5q6 -3 10 1M40 15q5 2 8 7" stroke="#C0392B" stroke-width="2.4" fill="none" stroke-linecap="round"/></g>`;
    case 7:
      return `<rect x="12" y="5" width="20" height="8" fill="#FFFFFF" stroke="#D9D4CC" stroke-width=".8"/><circle cx="15" cy="4" r="5" fill="#FFFFFF" stroke="#D9D4CC" stroke-width=".8"/><circle cx="29" cy="4" r="5" fill="#FFFFFF" stroke="#D9D4CC" stroke-width=".8"/><circle cx="22" cy="1" r="6.2" fill="#FFFFFF" stroke="#D9D4CC" stroke-width=".8"/><rect x="12.4" y="5.5" width="19.2" height="7" fill="#FFFFFF"/>`;
    case 8:
      return `<path d="M4 13Q6 2 22 2Q38 2 40 13Z" fill="#D63A3A"/><circle cx="13" cy="8" r="1.2" fill="#fff"/><circle cx="21" cy="5.5" r="1.2" fill="#fff"/><circle cx="30" cy="7" r="1.2" fill="#fff"/><path d="M40 10l6 -3M40 11.5l6 3" stroke="#D63A3A" stroke-width="2.4" stroke-linecap="round"/><path d="M4 16.5L40 13.5" stroke="${INK}" stroke-width="1.1"/><rect x="10" y="15" width="8" height="9.5" rx="2.4" fill="${INK}"/>`;
    case 9:
      return `<path d="M9 13Q9 3 22 3Q35 3 35 13Z" fill="#F25F5C"/><rect x="9" y="10" width="26" height="3" fill="#FFE066"/><rect x="21" y="-1" width="2" height="4.5" fill="#555"/><ellipse class="${moving ? "prop" : ""}" cx="22" cy="-1.5" rx="8" ry="1.7" fill="#4CC9F0"/><g fill="none" stroke="${INK}" stroke-width="1.4"><circle cx="14" cy="20" r="4.6"/><circle cx="30" cy="20" r="4.6"/><path d="M18.6 20h6.8"/></g>`;
    default:
      return "";
  }
}
function effects(mood) {
  switch (mood) {
    case "work":
      return `<path class="sp1" d="${sparkle(41, 10, 3.2)}" fill="#FFC857"/><path class="sp2" d="${sparkle(4, 8, 2.6)}" fill="#FF8FB1"/><path class="sp3" d="${sparkle(36, 4, 2.2)}" fill="#7CD4FD"/>`;
    case "done":
      return `<g class="pop"><circle cx="40" cy="5" r="7" style="fill:var(--ok)"/><path d="M36.6 5.2l2.3 2.3 4.4 -4.6" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></g>`;
    case "fail":
      return `<g class="pop"><circle cx="40" cy="5" r="7" style="fill:var(--err)"/><text x="40" y="9" text-anchor="middle" font-size="11" font-weight="800" fill="#fff">!</text></g>`;
    case "sleep":
      return `<text class="zz1 mu" x="38" y="8" font-size="9" font-weight="700">z</text><text class="zz2 mu" x="43" y="2" font-size="11" font-weight="700">Z</text>`;
    default:
      return "";
  }
}
function mascotSvg(skinIndex, mood, width, height) {
  const skin = skinOf(Math.max(0, skinIndex));
  const working = mood === "work";
  const legs = [8, 16, 24, 32].map((lx, i) => `<rect x="${lx}" y="31" width="4" height="8" fill="${skin.body}"${working ? ` class="${i % 2 ? "legB" : "legA"}"` : ""}/>`).join("");
  const arms = `<rect x="0" y="19" width="4" height="8" fill="${skin.body}"${working ? ' class="armL"' : ""}/><rect x="40" y="19" width="4" height="8" fill="${skin.body}"${working ? ' class="armR"' : ""}/>`;
  const body = `<rect x="4" y="12" width="36" height="20" rx="1.5" fill="${skin.body}"/><rect x="4" y="28" width="36" height="4" fill="${skin.dark}" opacity=".35"/><rect x="6" y="13.5" width="10" height="2" fill="#fff" opacity=".22"/>`;
  const motion = working ? "bob" : "br";
  const reaction = mood === "done" ? ' class="hop"' : mood === "fail" ? ' class="shake"' : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" ${frame(width, height)} viewBox="-10 -18 64 62"><style>${CSS}</style><ellipse class="shadow" cx="22" cy="40" rx="17" ry="2.6"/><g class="${mood === "fail" || mood === "sleep" ? "gray" : ""}"><g${reaction}><g>${legs}</g><g class="${motion}">${arms}${body}${eyes(mood)}${accessory(skinIndex, mood)}</g></g></g>${effects(mood)}</svg>`;
}
function logoSvg(isLive2, size) {
  const rays = Array.from({ length: 12 }, (_, i) => {
    const angle = i * Math.PI / 6;
    const r2 = i % 2 === 0 ? 9 : 7;
    return `M${(10 + 3.2 * Math.cos(angle)).toFixed(1)} ${(10 + 3.2 * Math.sin(angle)).toFixed(1)}L${(10 + r2 * Math.cos(angle)).toFixed(1)} ${(10 + r2 * Math.sin(angle)).toFixed(1)}`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" ${frame(size, size)} viewBox="0 0 20 20"><style>${CSS}</style><path class="${isLive2 ? "spin" : "spinS"}" style="transform-box:fill-box;transform-origin:center" d="${rays}" stroke="#D97757" stroke-width="2.3" stroke-linecap="round"/></svg>`;
}
function moodOf(agent) {
  if (isLive(agent.phase)) return "work";
  switch (agent.phase) {
    case "done":
      return "done";
    case "failed":
      return "fail";
    case "idle":
      return "idle";
    default:
      return "sleep";
  }
}
export {
  logoSvg,
  mascotSvg,
  moodOf
};
