/**
 * o2steam Achievement Plus - web part
 *
 * Runs on steamcommunity.com profile pages. Adds a "perfect games N" block (the blue-and-gold ribbon with the
 * number inside it) in the right column, under the Message / More buttons, for any profile you open.
 *
 * How it counts: it reads the profile's game list, then asks Steam for the achievement page of each game with
 * achievements (with your own Steam session, like opening those pages yourself) and counts the games where
 * every achievement is unlocked. That is one request per game, so it runs a few at a time, shows the number
 * growing while it works, and remembers the result in this browser for 12 hours. Nothing is sent anywhere
 * except to steamcommunity.com itself.
 */

const W = window as any;
const BLOCK_ID = 'o2ap-profile-perfect';
const CACHE_PREFIX = 'o2ap.perfect.v1.';
const CACHE_MS = 12 * 60 * 60 * 1000;
const PARALLEL = 4;
const BLUE = '#1a8fe8';

interface Cached {
	n: number;
	games: number;
	t: number;
}

function readCache(id: string): Cached | null {
	try {
		const c = JSON.parse(localStorage.getItem(CACHE_PREFIX + id) || 'null');
		return c && typeof c.n === 'number' ? c : null;
	} catch {
		return null;
	}
}

function writeCache(id: string, c: Cached) {
	try {
		localStorage.setItem(CACHE_PREFIX + id, JSON.stringify(c));
	} catch {}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- the look

function badgeSvg(n: string): string {
	const size = n.length >= 4 ? 17 : n.length === 3 ? 21 : 26;
	return (
		`<svg viewBox="0 0 64 72" width="64" height="72" xmlns="http://www.w3.org/2000/svg" style="overflow:visible;display:block">` +
		`<defs><radialGradient id="o2apg" cx="50%" cy="42%" r="58%"><stop offset="0%" stop-color="#fff0a0"/><stop offset="55%" stop-color="#f7b900"/><stop offset="100%" stop-color="#d98200"/></radialGradient></defs>` +
		`<path d="M16 40 L8 70 L22 61 L30 70 L35 44 Z" fill="${BLUE}"/>` +
		`<path d="M48 40 L56 70 L42 61 L34 70 L29 44 Z" fill="${BLUE}"/>` +
		`<polygon points="32,2 37,9 46,6 48,15 57,17 55,26 62,32 55,38 57,47 48,49 46,58 37,55 32,62 27,55 18,58 16,49 7,47 9,38 2,32 9,26 7,17 16,15 18,6 27,9" fill="${BLUE}"/>` +
		`<circle cx="32" cy="32" r="15" fill="url(#o2apg)"/>` +
		`<text x="32" y="32" text-anchor="middle" dominant-baseline="central" font-family="Arial,Helvetica,sans-serif" font-weight="700" font-size="${size}" fill="#e89a00" stroke="#8a4f00" stroke-width="0.8" paint-order="stroke">${n}</text>` +
		`</svg>`
	);
}

function makeBlock(): HTMLElement {
	const el = document.createElement('div');
	el.id = BLOCK_ID;
	el.style.cssText = 'display:flex;align-items:center;gap:6px;margin:14px 0 6px;color:#fff;filter:drop-shadow(0 0 7px rgba(255,214,90,.45))';
	return el;
}

function paint(el: HTMLElement, n: string, tip: string, note = '') {
	el.title = tip;
	el.innerHTML =
		`<div style="width:64px;height:72px;flex:none">${badgeSvg(n)}</div>` +
		`<div style="line-height:1.2"><span style="font-size:17px">perfect games</span> <span style="font-size:24px;opacity:.6;margin-left:3px">${n}</span>` +
		(note ? `<div style="font-size:11px;opacity:.6;margin-top:2px">${note}</div>` : '') +
		`</div>`;
}

// ---------------------------------------------------------------- counting

/**
 * Steam's own games page has a "Completed (N)" tab = the games with every achievement unlocked. That number is
 * what we show. It is drawn by the page itself, so it is read from the page (loaded in a hidden frame of this
 * same site, with your session) - first from the plain html in case it is already there.
 */
async function completedCount(id: string): Promise<{ n: number | null; why: string }> {
	const url = `https://steamcommunity.com/profiles/${id}/games/?tab=completed`;
	try {
		const res = await fetch(url, { credentials: 'include' });
		if (/\/login\//.test(res.url)) return { n: null, why: 'you are not signed in, or this games list is private' };
		const m = (await res.text()).match(/Completed\s*\((\d[\d,]*)\)/i);
		if (m) return { n: Number(m[1].replace(/,/g, '')), why: '' };
	} catch {}
	return new Promise((resolve) => {
		const f = document.createElement('iframe');
		f.style.cssText = 'position:fixed;left:-9999px;top:0;width:1200px;height:900px;border:0;visibility:hidden';
		f.src = url;
		let waited = 0;
		const finish = (r: { n: number | null; why: string }) => {
			clearInterval(t);
			f.remove();
			resolve(r);
		};
		const t = setInterval(() => {
			waited += 500;
			try {
				const w = f.contentWindow as Window;
				if (/\/login\//.test(w.location.href)) return finish({ n: null, why: 'you are not signed in, or this games list is private' });
				const m = (w.document.body?.innerText || '').match(/Completed\s*\((\d[\d,]*)\)/i);
				if (m) return finish({ n: Number(m[1].replace(/,/g, '')), why: '' });
			} catch {}
			if (waited >= 30000) finish({ n: null, why: 'the games page did not show a "Completed" tab (private games list?)' });
		}, 500);
		document.body.appendChild(f);
	});
}

let running = false;

async function count(id: string, el: HTMLElement) {
	if (running) return;
	running = true;
	try {
		const cached = readCache(id);
		if (cached) paint(el, String(cached.n), `Counted ${new Date(cached.t).toLocaleString()}`);
		if (cached && Date.now() - cached.t < CACHE_MS) return;
		const r = await completedCount(id);
		if (r.n === null) {
			if (!cached) paint(el, '?', 'Could not count: ' + r.why, r.why);
			return;
		}
		writeCache(id, { n: r.n, games: 0, t: Date.now() });
		paint(el, String(r.n), 'Counted just now');
	} catch (e) {
		if (!readCache(id)) paint(el, '?', 'Could not count', String((e as any)?.message || e));
	} finally {
		running = false;
	}
}

// ---------------------------------------------------------------- the page

export default async function WebkitMain() {
	if (!location.hostname.endsWith('steamcommunity.com')) return;
	if (!/^\/(id|profiles)\/[^/]+\/?$/.test(location.pathname)) return; // profile pages only

	const tick = () => {
		try {
			const id = String(W.g_rgProfileData?.steamid || '');
			if (!/^\d{17}$/.test(id)) return;
			if (document.getElementById(BLOCK_ID)) return;
			// Steam's own "perfect games" line (if there is one) is left alone
			if (/perfect games/i.test(document.querySelector('.profile_rightcol')?.textContent || '')) return;
			const col = document.querySelector<HTMLElement>('.profile_rightcol');
			if (!col) return;
			// above "Profile Awards" / "Badges" in the right column (the first block there that says so)
			const kids = Array.from(col.children) as HTMLElement[];
			const target =
				kids.find((k) => /^\s*(Profile Awards|Badges)\b/i.test(k.textContent || '')) ??
				kids.find((k) => k.classList.contains('responsive_count_link_area')) ??
				null;
			if (!target) return;
			const el = makeBlock();
			paint(el, '...', 'Counting perfect games...', 'counting...');
			col.insertBefore(el, target);
			void count(id, el);
		} catch {}
	};
	tick();
	setInterval(tick, 1500);
}
