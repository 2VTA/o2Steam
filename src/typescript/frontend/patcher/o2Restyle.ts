/**
 * o2steam: lets a theme restyle *all* of Steam's own interface without knowing its class names.
 *
 * Steam's stylesheets (sp.css, library.css, chunks loaded later) are read through the CSSOM here in the
 * shared context, and a second stylesheet is built from them in which every colour is pulled toward the
 * theme's phosphor colour (by luminance, so dark stays dark and light becomes the phosphor colour), corners
 * are squared and box shadows dropped. That stylesheet is appended to every Steam window after Steam's own,
 * so the same selectors win. Pictures are untouched - they keep their real colours.
 *
 * A theme opts in with an "o2Restyle" block in its skin.json:
 *   "o2Restyle": {
 *     "fg":       { "condition": "Phosphor colour", "default": "Amber", "values": { "Amber": "#ff8100", ... } },
 *     "strength": { "condition": "Restyle strength", "default": 70 },
 *     "square": true, "noShadows": true
 *   }
 */

import { pluginSelf } from '@steambrew/sdk';
import { ThemeItem } from '../types';

interface RestyleSettings {
	fg: [number, number, number];
	strength: number; // 0..1
	square: boolean;
	noShadows: boolean;
}

const STYLE_ID = 'o2steam-restyle';

let cachedKey = '';
let cachedCss = '';
let watchingSheets = false;

function parseHex(hex: string): [number, number, number] | undefined {
	const h = hex.trim().replace(/^#/, '');
	if (!/^[0-9a-f]{6}$/i.test(h)) return undefined;
	const v = parseInt(h, 16);
	return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function readSettings(theme: ThemeItem | undefined): RestyleSettings | undefined {
	const spec = (theme?.data as any)?.o2Restyle;
	if (!spec) return undefined;

	const saved: Record<string, string> = pluginSelf?.conditionals?.[theme!.native] ?? {};
	const fgName = saved[spec.fg?.condition] ?? spec.fg?.default;
	const fg = parseHex(spec.fg?.values?.[fgName] ?? '');
	if (!fg) return undefined;

	const rawStrength = Number(saved[spec.strength?.condition] ?? spec.strength?.default ?? 70);
	return {
		fg,
		strength: Math.max(0, Math.min(1, (isNaN(rawStrength) ? 70 : rawStrength) / 100)),
		square: spec.square !== false,
		noShadows: spec.noShadows !== false,
	};
}

// ---------------------------------------------------------------- colour mapping

function mapRgb(r: number, g: number, b: number, a: number, s: RestyleSettings): string {
	// terminal contrast: Steam's dark greys go to black, its light text goes to the full phosphor colour
	const raw = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
	const lum = Math.pow(Math.max(0, Math.min(1, (raw - 0.1) / 0.6)), 1.15);
	const k = s.strength;
	const out = [r, g, b].map((c, i) => Math.round(Math.max(0, Math.min(255, c * (1 - k) + s.fg[i] * lum * k))));
	return a >= 0.999 ? `rgb(${out[0]}, ${out[1]}, ${out[2]})` : `rgba(${out[0]}, ${out[1]}, ${out[2]}, ${Math.round(a * 1000) / 1000})`;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
	h = (((h % 360) + 360) % 360) / 360;
	const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
	const p = 2 * l - q;
	const f = (t: number) => {
		if (t < 0) t += 1;
		if (t > 1) t -= 1;
		const v = t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
		return v * 255;
	};
	return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}

const COLOR_RE = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\([^()]*\)|\b(?:white|black)\b/gi;

function mapColorToken(token: string, s: RestyleSettings): string {
	const t = token.toLowerCase();
	if (t === 'white') return mapRgb(255, 255, 255, 1, s);
	if (t === 'black') return mapRgb(0, 0, 0, 1, s);

	if (t.startsWith('#')) {
		const h = t.slice(1);
		if (![3, 4, 6, 8].includes(h.length)) return token;
		const full = h.length <= 4 ? h.split('').map((c) => c + c).join('') : h;
		const n = (i: number) => parseInt(full.slice(i, i + 2), 16);
		return mapRgb(n(0), n(2), n(4), full.length === 8 ? n(6) / 255 : 1, s);
	}

	const isHsl = t.startsWith('hsl');
	const inner = t.slice(t.indexOf('(') + 1, -1);
	if (inner.includes('var') || inner.includes('calc')) return token;
	const parts = inner.replace(/\//g, ' ').replace(/,/g, ' ').trim().split(/\s+/);
	if (parts.length < 3) return token;
	const num = (p: string) => parseFloat(p);
	let alpha = parts.length >= 4 ? num(parts[3]) : 1;
	if (parts[3]?.endsWith('%')) alpha /= 100;
	if ([0, 1, 2].some((i) => isNaN(num(parts[i]))) || isNaN(alpha)) return token;

	if (isHsl) {
		const [r, g, b] = hslToRgb(num(parts[0]), num(parts[1]) / 100, num(parts[2]) / 100);
		return mapRgb(r, g, b, alpha, s);
	}
	const ch = (p: string) => (p.endsWith('%') ? num(p) * 2.55 : num(p));
	return mapRgb(ch(parts[0]), ch(parts[1]), ch(parts[2]), alpha, s);
}

/** Recolours a declaration value, leaving url(...) parts alone. */
function mapValue(value: string, s: RestyleSettings): string {
	return value
		.split(/(url\([^)]*\))/i)
		.map((part) => (/^url\(/i.test(part) ? part : part.replace(COLOR_RE, (m) => mapColorToken(m, s))))
		.join('');
}

// ---------------------------------------------------------------- stylesheet generation

function restyleRules(rules: CSSRuleList, s: RestyleSettings, out: string[]) {
	for (const rule of Array.from(rules)) {
		if (rule instanceof CSSStyleRule) {
			const decls: string[] = [];
			const style = rule.style;
			for (let i = 0; i < style.length; i++) {
				const prop = style[i];
				const value = style.getPropertyValue(prop);
				const important = style.getPropertyPriority(prop) ? ' !important' : '';
				let next: string | undefined;

				if (s.square && prop.includes('radius')) {
					if (value.trim() !== '0' && value.trim() !== '0px') next = '0';
				} else if (s.noShadows && prop === 'box-shadow') {
					if (value.trim() !== 'none') next = 'none';
				} else if (s.strength > 0) {
					const mapped = mapValue(value, s);
					if (mapped !== value) next = mapped;
				}

				if (next !== undefined) decls.push(`${prop}:${next}${important}`);
			}
			if (decls.length) out.push(`${rule.selectorText}{${decls.join(';')}}`);
		} else if (rule instanceof CSSMediaRule) {
			const inner: string[] = [];
			restyleRules(rule.cssRules, s, inner);
			if (inner.length) out.push(`@media ${rule.conditionText}{${inner.join('')}}`);
		} else if ((rule as any).cssRules && (rule.constructor?.name === 'CSSSupportsRule' || rule.constructor?.name === 'CSSLayerBlockRule')) {
			const inner: string[] = [];
			restyleRules((rule as any).cssRules, s, inner);
			if (inner.length) out.push(`@supports ${(rule as any).conditionText ?? 'all'}{${inner.join('')}}`);
		}
	}
}

/** Steam's own sheets in the shared context (theme and o2steam sheets are skipped). */
function steamSheets(): CSSStyleSheet[] {
	return Array.from(document.styleSheets).filter((sheet) => {
		const owner = sheet.ownerNode as Element | null;
		if (owner?.id === STYLE_ID) return false;
		const href = sheet.href ?? '';
		return href.includes('steamloopback.host') || (!href && owner?.tagName === 'STYLE' && !owner.id);
	});
}

function buildCss(s: RestyleSettings): string {
	const sheets = steamSheets();
	const key = `${s.fg.join(',')}|${s.strength}|${s.square}|${s.noShadows}|${sheets.map((x) => (x.href ?? 'inline') + ':' + safeRuleCount(x)).join(',')}`;
	if (key === cachedKey) return cachedCss;

	const t0 = performance.now();
	const out: string[] = [];
	for (const sheet of sheets) {
		try {
			restyleRules(sheet.cssRules, s, out);
		} catch {
			/* cross-origin or not loaded yet */
		}
	}
	cachedKey = key;
	cachedCss = out.join('\n');
	console.log(`[o2steam] restyle built ${out.length} rules from ${sheets.length} sheets in ${Math.round(performance.now() - t0)}ms`);
	return cachedCss;
}

function safeRuleCount(sheet: CSSStyleSheet): number {
	try {
		return sheet.cssRules.length;
	} catch {
		return 0;
	}
}

function applyToDocument(doc: Document, css: string) {
	let el = doc.getElementById(STYLE_ID) as HTMLStyleElement | null;
	if (!el) {
		el = doc.createElement('style');
		el.id = STYLE_ID;
	}
	// compare a short key instead of the 2-3 MB text
	if (el.dataset.o2key !== cachedKey) {
		el.textContent = css;
		el.dataset.o2key = cachedKey;
	}
	// keep it after Steam's sheets (Steam appends more as chunks load)
	if (doc.head && doc.head.lastElementChild !== el) doc.head.appendChild(el);
}

function refreshAllWindows() {
	const s = readSettings(pluginSelf?.activeTheme);
	if (!s) return;
	const css = buildCss(s);
	try {
		for (const popup of Array.from((window as any).g_PopupManager?.GetPopups?.() ?? []) as any[]) {
			const doc: Document | undefined = popup?.window?.document;
			if (doc?.head && wantsRestyle(popup?.m_strName ?? '', popup?.m_strTitle ?? popup?.title ?? '')) applyToDocument(doc, css);
		}
	} catch {}
}

/** Steam loads more CSS chunks while you browse; rebuild when that happens. */
function watchForNewSheets() {
	if (watchingSheets) return;
	watchingSheets = true;
	let timer: number | undefined;
	new MutationObserver(() => {
		clearTimeout(timer);
		timer = window.setTimeout(refreshAllWindows, 400);
	}).observe(document.head, { childList: true });
}

/**
 * Menus and the top-bar pop-ups are styled by the theme's own menu sheet; giving each of them the full
 * recoloured copy of Steam's CSS would only cost a parse every time a menu opens.
 */
function wantsRestyle(windowName: string, title: string): boolean {
	return !/contextmenu/i.test(windowName) && !/(Menu|Supernav)$/.test(title);
}

/** Called for every Steam window as it is themed. */
export function applyO2Restyle(doc: Document, windowName = '', title = '') {
	if (!wantsRestyle(windowName, title)) return;
	const s = readSettings(pluginSelf?.activeTheme);
	if (!s) return;
	try {
		applyToDocument(doc, buildCss(s));
		watchForNewSheets();
	} catch (e) {
		console.error('[o2steam] restyle failed', e);
	}
}
