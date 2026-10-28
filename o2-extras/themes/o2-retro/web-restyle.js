/*
 * o2 Retro Terminal - recolours Steam's web pages (store, community, the new market) the same way o2steam
 * recolours the client: every colour in the page's own stylesheets is pulled toward the phosphor colour by
 * luminance (dark stays dark, light becomes the phosphor colour), corners are squared and shadows dropped.
 * Pictures keep their real colours. Works on hashed class names because it reads the stylesheets themselves.
 *
 * The phosphor colour comes from the theme's --o2-fg (set by the colour profile); the strength from
 * --o2-restyle when set, else 85%.
 */
(() => {
	const STYLE_ID = "o2steam-web-restyle";
	if (window.__o2WebRestyle) return;
	window.__o2WebRestyle = true;

	function settings() {
		const cs = getComputedStyle(document.documentElement);
		const fg = (cs.getPropertyValue("--o2-fg") || "#ff8100").trim();
		const m = /^#?([0-9a-f]{6})$/i.exec(fg);
		if (!m) return null;
		const v = parseInt(m[1], 16);
		const strengthRaw = parseFloat(cs.getPropertyValue("--o2-restyle"));
		return {
			fg: [(v >> 16) & 255, (v >> 8) & 255, v & 255],
			strength: Math.max(0, Math.min(1, isNaN(strengthRaw) ? 0.85 : strengthRaw / 100)),
		};
	}

	function mapRgb(r, g, b, a, s) {
		const raw = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
		const lum = Math.pow(Math.max(0, Math.min(1, (raw - 0.1) / 0.6)), 1.15);
		const k = s.strength;
		const o = [r, g, b].map((c, i) => Math.round(Math.max(0, Math.min(255, c * (1 - k) + s.fg[i] * lum * k))));
		return a >= 0.999 ? `rgb(${o[0]}, ${o[1]}, ${o[2]})` : `rgba(${o[0]}, ${o[1]}, ${o[2]}, ${Math.round(a * 1000) / 1000})`;
	}

	function hslToRgb(h, sat, l) {
		h = (((h % 360) + 360) % 360) / 360;
		const q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat;
		const p = 2 * l - q;
		const f = (t) => {
			if (t < 0) t += 1;
			if (t > 1) t -= 1;
			const v = t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
			return v * 255;
		};
		return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
	}

	const COLOR_RE = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\([^()]*\)|\b(?:white|black)\b/gi;

	function mapToken(token, s) {
		const t = token.toLowerCase();
		if (t === "white") return mapRgb(255, 255, 255, 1, s);
		if (t === "black") return mapRgb(0, 0, 0, 1, s);
		if (t[0] === "#") {
			const h = t.slice(1);
			if (![3, 4, 6, 8].includes(h.length)) return token;
			const full = h.length <= 4 ? h.split("").map((c) => c + c).join("") : h;
			const n = (i) => parseInt(full.slice(i, i + 2), 16);
			return mapRgb(n(0), n(2), n(4), full.length === 8 ? n(6) / 255 : 1, s);
		}
		const inner = t.slice(t.indexOf("(") + 1, -1);
		if (inner.includes("var") || inner.includes("calc")) return token;
		const parts = inner.replace(/\//g, " ").replace(/,/g, " ").trim().split(/\s+/);
		if (parts.length < 3) return token;
		const num = parseFloat;
		let alpha = parts.length >= 4 ? num(parts[3]) : 1;
		if (parts[3] && parts[3].endsWith("%")) alpha /= 100;
		if ([0, 1, 2].some((i) => isNaN(num(parts[i]))) || isNaN(alpha)) return token;
		if (t.startsWith("hsl")) {
			const [r, g, b] = hslToRgb(num(parts[0]), num(parts[1]) / 100, num(parts[2]) / 100);
			return mapRgb(r, g, b, alpha, s);
		}
		const ch = (p) => (p.endsWith("%") ? num(p) * 2.55 : num(p));
		return mapRgb(ch(parts[0]), ch(parts[1]), ch(parts[2]), alpha, s);
	}

	function mapValue(value, s) {
		return value
			.split(/(url\([^)]*\))/i)
			.map((part) => (/^url\(/i.test(part) ? part : part.replace(COLOR_RE, (m) => mapToken(m, s))))
			.join("");
	}

	function restyleRules(rules, s, out) {
		for (const rule of Array.from(rules)) {
			if (rule instanceof CSSStyleRule) {
				const decls = [];
				const st = rule.style;
				for (let i = 0; i < st.length; i++) {
					const prop = st[i];
					const value = st.getPropertyValue(prop);
					const imp = st.getPropertyPriority(prop) ? " !important" : "";
					let next;
					if (prop.includes("radius")) {
						if (value.trim() !== "0" && value.trim() !== "0px") next = "0";
					} else if (prop === "box-shadow") {
						if (value.trim() !== "none") next = "none";
					} else {
						const mapped = mapValue(value, s);
						if (mapped !== value) next = mapped;
					}
					if (next !== undefined) decls.push(`${prop}:${next}${imp}`);
				}
				if (decls.length) out.push(`${rule.selectorText}{${decls.join(";")}}`);
			} else if (rule instanceof CSSMediaRule) {
				const inner = [];
				restyleRules(rule.cssRules, s, inner);
				if (inner.length) out.push(`@media ${rule.conditionText}{${inner.join("")}}`);
			}
		}
	}

	let lastKey = "";

	function apply() {
		const s = settings();
		if (!s) return;
		const sheets = Array.from(document.styleSheets).filter((sheet) => {
			const owner = sheet.ownerNode;
			if (owner && owner.id === STYLE_ID) return false;
			// the theme's own sheets are already in phosphor colours
			if ((sheet.href || "").includes("millennium.host")) return false;
			return true;
		});
		const count = (sh) => {
			try {
				return sh.cssRules.length;
			} catch {
				return -1;
			}
		};
		const key = `${s.fg}|${s.strength}|${sheets.map((x) => (x.href || "i") + count(x)).join(",")}`;
		if (key === lastKey) return;
		lastKey = key;

		const out = [];
		for (const sheet of sheets) {
			try {
				restyleRules(sheet.cssRules, s, out);
			} catch {
				/* a sheet from another origin without CORS - skipped */
			}
		}
		let el = document.getElementById(STYLE_ID);
		if (!el) {
			el = document.createElement("style");
			el.id = STYLE_ID;
		}
		el.textContent = out.join("\n");
		// after the page's own sheets so the same selectors win (the theme's rules use !important)
		if (document.head.lastElementChild !== el) document.head.appendChild(el);
	}

	let timer;
	const schedule = () => {
		clearTimeout(timer);
		timer = setTimeout(apply, 300);
	};

	const start = () => {
		apply();
		new MutationObserver(schedule).observe(document.head, { childList: true });
		window.addEventListener("load", schedule, { once: true });
	};

	if (document.head) start();
	else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
