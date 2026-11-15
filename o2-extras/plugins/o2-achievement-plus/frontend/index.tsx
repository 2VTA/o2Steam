/**
 * o2steam Achievement Plus
 *
 *  - the blue-and-gold "perfect game" ribbon: in the game's stats bar, on the avatars of friends who finished it
 *  - Achievement Challenge: a local race to 100% against a friend (panel on the game page + big comparison window)
 *  - "Achievers with your friends" chart (FRIEND / WORLD)
 *  - activity cards for friends who finished the game and for finished challenges
 *  - your perfect-games count
 *
 * Where the facts come from (inside Steam only, nothing is sent anywhere, no message is ever sent to a friend):
 *   SteamClient.Apps.GetFriendAchievementsForApp(appid, steamid64) - the call Steam's own "Compare to friends"
 *   uses. It works for yourself and for friends whose achievements are public.
 */

declare const g_PopupManager: any;
declare const friendStore: any;
declare const appStore: any;
declare const SteamClient: any;

const W = window as any;
const STORAGE_KEY = 'o2steam-achievement-plus.v1';
const STYLE_ID = 'o2ap-style';
const BLUE = '#1a8fe8';
const ORANGE = '#e0901a';
const STEAMID64_BASE = 76561197960265728n;

// ---------------------------------------------------------------- saved settings

interface Challenge {
	id: string;
	appid: string;
	appName: string;
	friendId: string;
	friendName: string;
	startedAt: number;
	finished?: { winner: 'me' | 'friend'; at: number };
}

interface Saved {
	ribbonStats: boolean;
	ribbonFriends: boolean;
	feedCards: boolean;
	challenges: Challenge[];
	perfectCount: number | null;
	perfectCountAt: number;
}

const state = {
	saved: { ribbonStats: true, ribbonFriends: true, feedCards: true, challenges: [], perfectCount: null, perfectCountAt: 0 } as Saved,
	listeners: new Set<() => void>(),
	scanProgress: '',
};

function loadSaved() {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw) state.saved = { ...state.saved, ...JSON.parse(raw) };
	} catch {}
}

function persist() {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(state.saved));
	} catch {}
}

function notify() {
	state.listeners.forEach((l) => l());
}

// ---------------------------------------------------------------- Steam data

interface Ach {
	id: string;
	name: string;
	desc: string;
	done: boolean;
	at: number; // unix seconds, 0 when locked
	icon: string;
	global: number; // % of all players who unlocked it
	hidden: boolean;
}

interface Progress {
	list: Ach[];
	done: number;
	total: number;
	perfect: boolean;
	percent: number;
}

const cache = new Map<string, { t: number; p: Promise<Progress | null> }>();
const CACHE_MS = 4 * 60 * 1000;

function mySteamId(): string {
	try {
		return friendStore.currentUserSteamID.ConvertTo64BitString();
	} catch {
		return '';
	}
}

/** achievements of one person in one game; remembered for a few minutes */
function progressOf(appid: string, steamid: string, fresh = false): Promise<Progress | null> {
	const key = `${appid}:${steamid}`;
	const hit = cache.get(key);
	if (hit && !fresh && Date.now() - hit.t < CACHE_MS) return hit.p;
	const p = (async () => {
		try {
			const r = await SteamClient.Apps.GetFriendAchievementsForApp(appid, steamid);
			const raw = r?.result === 1 ? r?.data?.rgAchievements : null;
			if (!Array.isArray(raw) || !raw.length) return null;
			const list: Ach[] = raw.map((a: any) => ({
				id: String(a.strID),
				name: String(a.strName ?? a.strID),
				desc: String(a.strDescription ?? ''),
				done: !!a.bAchieved,
				at: Number(a.rtUnlocked) || 0,
				icon: String(a.strImage ?? ''),
				global: Number(a.flAchieved) || 0,
				hidden: !!a.bHidden,
			}));
			const done = list.filter((a) => a.done).length;
			return { list, done, total: list.length, perfect: done === list.length, percent: Math.round((done / list.length) * 100) };
		} catch {
			return null;
		}
	})();
	cache.set(key, { t: Date.now(), p });
	return p;
}

interface FriendInfo {
	id: string;
	name: string;
	avatar: string;
}

function avatarUrl(hash: string): string {
	return hash ? `https://avatars.steamstatic.com/${hash}_full.jpg` : '';
}

function friends(): FriendInfo[] {
	const out: FriendInfo[] = [];
	try {
		for (const f of friendStore.allFriends) {
			const id = f.persona?.m_steamid?.ConvertTo64BitString?.();
			if (!id) continue;
			out.push({ id, name: String(f.display_name ?? f.persona?.m_strPlayerName ?? id), avatar: avatarUrl(f.persona?.m_strAvatarHash ?? '') });
		}
	} catch {}
	return out;
}

function friendById(id: string): FriendInfo | null {
	return friends().find((f) => f.id === id) ?? null;
}

function me(): FriendInfo {
	const id = mySteamId();
	try {
		// the signed-in user is in the UI friend store as `self` (the plain friend list leaves you out)
		const self = friendStore.m_FriendsUIFriendStore?.self ?? friendStore.m_FriendsUIFriendStore?.GetPlayer?.(Number(BigInt(id) - STEAMID64_BASE));
		const p = self?.persona ?? friendStore.m_mapPlayerCache?.get?.(Number(BigInt(id) - STEAMID64_BASE))?.m_persona;
		return { id, name: String(p?.m_strPlayerName ?? 'You'), avatar: avatarUrl(p?.m_strAvatarHash ?? '') };
	} catch {
		return { id, name: 'You', avatar: '' };
	}
}

function appInfo(appid: string): { name: string; hours: number } {
	try {
		const a = appStore.GetAppOverviewByAppID(Number(appid));
		return { name: String(a?.display_name ?? `App ${appid}`), hours: Math.round(((a?.minutes_playtime_forever ?? 0) / 60) * 10) / 10 };
	} catch {
		return { name: `App ${appid}`, hours: 0 };
	}
}

/** the first React prop called `name` found walking up from a DOM node */
function fiberProp(el: Element, names: string[], levels = 14): any {
	const key = Object.keys(el).find((k) => k.startsWith('__reactFiber'));
	let f = key ? (el as any)[key] : null;
	for (let i = 0; i < levels && f; i++, f = f.return) {
		const p = f.memoizedProps;
		if (!p || typeof p !== 'object') continue;
		for (const n of names) if (p[n] !== undefined && p[n] !== null) return p[n];
	}
	return undefined;
}

function friendIdOfElement(el: Element): string {
	const fr = fiberProp(el, ['friend']);
	try {
		return fr?.persona?.m_steamid?.ConvertTo64BitString?.() ?? '';
	} catch {
		return '';
	}
}

function appIdOfPage(doc: Document): string {
	for (const sel of ['.FriendsSection', '.ActivityFeedContainer', '.GameStatRight', '.AchievementsPageContainer']) {
		const el = doc.querySelector(sel);
		if (!el) continue;
		const v = fiberProp(el, ['appid', 'overview', 'app'], 30);
		const id = typeof v === 'object' ? v?.appid : v;
		if (id) return String(id);
	}
	return '';
}

// ---------------------------------------------------------------- look

function ribbonSvg(size: number, uid: string): string {
	return (
		`<svg viewBox="0 0 64 70" width="${size}" height="${Math.round((size * 70) / 64)}" xmlns="http://www.w3.org/2000/svg" style="overflow:visible">` +
		`<defs><radialGradient id="g${uid}" cx="50%" cy="42%" r="58%"><stop offset="0%" stop-color="#fff0a0"/><stop offset="55%" stop-color="#f7b900"/><stop offset="100%" stop-color="#d98200"/></radialGradient></defs>` +
		`<path d="M16 40 L8 68 L22 59 L30 68 L35 44 Z" fill="${BLUE}"/>` +
		`<path d="M48 40 L56 68 L42 59 L34 68 L29 44 Z" fill="${BLUE}"/>` +
		`<polygon points="32,2 37,9 46,6 48,15 57,17 55,26 62,32 55,38 57,47 48,49 46,58 37,55 32,62 27,55 18,58 16,49 7,47 9,38 2,32 9,26 7,17 16,15 18,6 27,9" fill="${BLUE}"/>` +
		`<circle cx="32" cy="32" r="15" fill="url(#g${uid})"/>` +
		`</svg>`
	);
}

let uidCounter = 0;
function ribbon(doc: Document, size: number, tip: string): HTMLElement {
	const el = doc.createElement('span');
	el.className = 'o2ap-badge';
	el.title = tip;
	el.innerHTML = ribbonSvg(size, String(++uidCounter));
	return el;
}

function ensureStyle(doc: Document) {
	if (doc.getElementById(STYLE_ID)) return;
	const style = doc.createElement('style');
	style.id = STYLE_ID;
	style.textContent = `
.o2ap-badge{display:inline-flex;vertical-align:middle;margin-right:6px;filter:drop-shadow(0 0 5px rgba(255,214,90,.7));flex:none}
.o2ap-avbadge{position:absolute;right:-4px;bottom:-4px;z-index:5;margin:0;pointer-events:auto}
.o2ap-btn{background:rgba(26,143,232,.22);color:#cfe6ff;border:1px solid rgba(26,143,232,.6);border-radius:3px;padding:6px 14px;font:inherit;font-size:12px;
  cursor:pointer;margin:6px 6px 0 0}
.o2ap-btn:hover{background:rgba(26,143,232,.4);color:#fff}
.o2ap-btn.o2ap-sel{background:${BLUE};color:#fff}
.o2ap-section{margin-top:18px}
.o2ap-sechead{font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.8;margin:0 0 6px 0;padding-left:9px}
.o2ap-toast{position:fixed;right:18px;bottom:110px;z-index:100000;background:#1b2230;border:1px solid rgba(26,143,232,.6);border-radius:6px;padding:12px 16px;color:#e5eef7;display:flex;gap:12px;align-items:center;box-shadow:0 10px 30px rgba(0,0,0,.5);max-width:360px;font-size:13px}
.o2ap-card{background:rgba(0,0,0,.28);border:1px solid rgba(255,255,255,.07);border-radius:3px;padding:12px;color:#c6d4df;cursor:pointer}
.o2ap-row{display:flex;align-items:center;justify-content:space-between;gap:10px}
.o2ap-face{width:46px;height:46px;border-radius:3px;object-fit:cover;background:#222}
.o2ap-big{font-size:26px;font-weight:300;color:#e5eef7;line-height:1.1}
.o2ap-sub{font-size:12px;opacity:.65}
.o2ap-bar{height:8px;background:#000;border-radius:4px;overflow:hidden;margin-top:4px}
.o2ap-bar>i{display:block;height:100%}
.o2ap-feed{background:rgba(0,0,0,.22);border:1px solid rgba(255,255,255,.06);border-radius:3px;padding:12px 14px;margin:10px 0;color:#c6d4df;display:flex;gap:16px;align-items:center}
.o2ap-feed h3{margin:0;font-size:22px;font-weight:300;color:#e5eef7}
.o2ap-over{position:fixed;inset:0;z-index:99999;background:rgba(5,8,14,.72);display:flex;align-items:center;justify-content:center}
.o2ap-modal{background:#1b2230;border-radius:14px;color:#c6d4df;width:min(1100px,92vw);max-height:90vh;overflow:auto;padding:22px 26px;box-shadow:0 20px 60px rgba(0,0,0,.6);position:relative}
.o2ap-x{position:absolute;right:14px;top:10px;font-size:22px;cursor:pointer;opacity:.7}
.o2ap-x:hover{opacity:1}
.o2ap-title{font-size:26px;font-weight:600;color:#fff;text-align:center;margin:0 0 4px}
.o2ap-list{display:flex;flex-wrap:wrap;gap:4px;background:rgba(0,0,0,.28);padding:6px;border-radius:3px;min-height:48px}
.o2ap-list img{width:34px;height:34px;border-radius:3px}
.o2ap-pick{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:8px;margin-top:12px;max-height:50vh;overflow:auto}
.o2ap-pickitem{display:flex;align-items:center;gap:10px;padding:8px;border-radius:4px;background:rgba(255,255,255,.05);cursor:pointer}
.o2ap-pickitem:hover{background:rgba(26,143,232,.3)}
.o2ap-pickitem img{width:36px;height:36px;border-radius:3px}
`;
	(doc.head || doc.documentElement).appendChild(style);
}

const NO_AVATAR = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#2a3446"/><circle cx="32" cy="24" r="11" fill="#5d6b82"/><path d="M10 60c2-16 14-22 22-22s20 6 22 22z" fill="#5d6b82"/></svg>');

function el(doc: Document, tag: string, props: Record<string, any> = {}, ...kids: (Node | string | null)[]): HTMLElement {
	const e = doc.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (k === 'style') e.setAttribute('style', v);
		else if (k === 'class') e.className = v;
		else if (k.startsWith('on')) (e as any)[k] = v;
		else e.setAttribute(k, v);
	}
	if (tag === 'img') {
		// a picture that is missing or fails to load shows a plain silhouette instead of a broken-image icon
		if (!props.src) e.setAttribute('src', NO_AVATAR);
		(e as HTMLImageElement).onerror = () => {
			if (e.getAttribute('src') !== NO_AVATAR) e.setAttribute('src', NO_AVATAR);
		};
	}
	for (const k of kids) if (k !== null) e.append(k as any);
	return e;
}

function pctBar(doc: Document, pct: number, color: string): HTMLElement {
	return el(doc, 'div', { class: 'o2ap-bar' }, el(doc, 'i', { style: `width:${Math.max(0, Math.min(100, pct))}%;background:${color}` }));
}

// ---------------------------------------------------------------- stats bar + friends ribbons

function decorateStatsBar(doc: Document) {
	const row = doc.querySelector('.GameStatRight .AchievementProgressRow') as HTMLElement | null;
	if (!row) return;
	const holder = row.parentElement as HTMLElement;
	const label = holder.querySelector('.PlayBarLabel') as HTMLElement | null;
	const m = /(\d+)\s*\/\s*(\d+)/.exec(row.querySelector('.AchievementCountLabel')?.textContent ?? '');
	if (!m) return;
	const perfect = state.saved.ribbonStats && Number(m[1]) > 0 && m[1] === m[2];
	const existing = holder.querySelector('.o2ap-badge');
	if (!perfect) return void existing?.remove();
	if (existing || !label) return;
	label.prepend(ribbon(doc, 16, `Perfect game: ${m[1]}/${m[2]} achievements`));
}

function decorateFriendAvatars(doc: Document) {
	if (!state.saved.ribbonFriends) return;
	const appid = appIdOfPage(doc);
	if (!appid) return;
	const entries = doc.querySelectorAll('.FriendsSection .AvatarAndLabel, .FriendsSection .OverflowBoxContent > .Panel');
	entries.forEach((entry) => {
		const e = entry as HTMLElement;
		if (e.dataset.o2apApp === appid) return;
		const id = friendIdOfElement(e);
		const img = e.querySelector('img') as HTMLElement | null;
		if (!id || !img?.parentElement) return;
		e.dataset.o2apApp = appid;
		void progressOf(appid, id).then((p) => {
			if (!p?.perfect || e.querySelector('.o2ap-avbadge')) return;
			const host = img.parentElement as HTMLElement;
			if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
			const b = ribbon(doc, 14, 'Finished this game: 100% achievements');
			b.classList.add('o2ap-avbadge');
			host.appendChild(b);
		});
	});
}

// ---------------------------------------------------------------- challenges

function challengeFor(appid: string): Challenge[] {
	return state.saved.challenges.filter((c) => c.appid === appid);
}

function closeModal(doc: Document) {
	doc.getElementById('o2ap-modal')?.remove();
}

function openModal(doc: Document, build: (box: HTMLElement) => void) {
	closeModal(doc);
	const box = el(doc, 'div', { class: 'o2ap-modal' });
	const over = el(doc, 'div', { class: 'o2ap-over', id: 'o2ap-modal', onclick: (ev: any) => ev.target === over && closeModal(doc) });
	box.append(el(doc, 'div', { class: 'o2ap-x', onclick: () => closeModal(doc) }, '×'));
	over.append(box);
	(doc.body || doc.documentElement).appendChild(over);
	build(box);
}

/** pick a friend: only friends who own the game and have public achievements are listed */
function openFriendPicker(doc: Document, appid: string, appName: string) {
	openModal(doc, (box) => {
		box.append(el(doc, 'h2', { class: 'o2ap-title' }, `Challenge a friend in ${appName}`));
		const note = el(doc, 'div', { class: 'o2ap-sub', style: 'text-align:center' }, 'Looking for friends who have this game with public achievements...');
		const grid = el(doc, 'div', { class: 'o2ap-pick' });
		box.append(note, grid);
		const list = friends();
		const taken = new Set(challengeFor(appid).map((c) => c.friendId));
		let checked = 0;
		let found = 0;
		const queue = list.slice();
		const worker = async () => {
			while (queue.length) {
				const f = queue.shift()!;
				const p = await progressOf(appid, f.id);
				checked++;
				if (p && !taken.has(f.id)) {
					found++;
					grid.append(
						el(
							doc,
							'div',
							{
								class: 'o2ap-pickitem',
								onclick: () => {
									startChallenge(appid, appName, f);
									closeModal(doc);
									scanAll();
									openComparison(doc, state.saved.challenges[state.saved.challenges.length - 1]);
								},
							},
							el(doc, 'img', { src: f.avatar }),
							el(doc, 'div', {}, el(doc, 'div', {}, f.name), el(doc, 'div', { class: 'o2ap-sub' }, `${p.done}/${p.total} - ${p.percent}%`)),
						),
					);
				}
				note.textContent = `Checked ${checked} of ${list.length} friends - ${found} can race you.`;
			}
		};
		void Promise.all([worker(), worker(), worker(), worker(), worker()]).then(() => {
			note.textContent = found ? `${found} friend(s) can race you. Pick one.` : 'No friend with this game and public achievements was found.';
		});
	});
}

function startChallenge(appid: string, appName: string, f: FriendInfo) {
	state.saved.challenges.push({
		id: `${appid}-${f.id}-${Date.now()}`,
		appid,
		appName,
		friendId: f.id,
		friendName: f.name,
		startedAt: Date.now(),
	});
	persist();
	notify();
}

function dayLabel(d: Date): string {
	return `${d.getDate()} ${d.toLocaleString('en', { month: 'short' }).toLowerCase()}`;
}

/** achievements unlocked up to the end of each of the last `days` days, as a percentage */
function cumulativeByDay(p: Progress, days: number): { label: string; pct: number }[] {
	const out: { label: string; pct: number }[] = [];
	const now = new Date();
	for (let i = days - 1; i >= 0; i--) {
		const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i, 23, 59, 59).getTime() / 1000;
		const n = p.list.filter((a) => a.done && a.at && a.at <= end).length;
		out.push({ label: dayLabel(new Date(end * 1000)), pct: Math.round((n / p.total) * 100) });
	}
	return out;
}

async function openComparison(doc: Document, c: Challenge) {
	const mine = me();
	const other = friendById(c.friendId) ?? { id: c.friendId, name: c.friendName, avatar: '' };
	openModal(doc, (box) => {
		box.append(el(doc, 'div', { class: 'o2ap-sub', style: 'text-align:center' }, 'Loading achievements...'));
		void (async () => {
			const [a, b] = await Promise.all([progressOf(c.appid, mine.id, true), progressOf(c.appid, other.id, true)]);
			box.innerHTML = '';
			box.append(el(doc, 'div', { class: 'o2ap-x', onclick: () => closeModal(doc) }, '×'));
			if (!a || !b) return void box.append(el(doc, 'div', { style: 'padding:30px;text-align:center' }, "Couldn't read one of the two achievement lists (private profile?)."));
			const hours = appInfo(c.appid).hours;
			const side = (who: FriendInfo, p: Progress, color: string, hrs: string, alignRight: boolean) =>
				el(
					doc,
					'div',
					{ style: `display:flex;flex-direction:column;align-items:${alignRight ? 'flex-end' : 'flex-start'};gap:4px;min-width:150px` },
					el(doc, 'img', { class: 'o2ap-face', src: who.avatar, style: 'width:90px;height:90px' }),
					el(doc, 'div', { class: 'o2ap-big', style: `color:${color}` }, `${p.percent}%`),
					el(doc, 'div', { class: 'o2ap-sub' }, `${who.name} - ${p.done}/${p.total}${hrs}`),
				);
			const vs = el(doc, 'div', { style: 'text-align:center;flex:1' }, el(doc, 'h2', { class: 'o2ap-title' }, c.appName));
			vs.append(el(doc, 'div', { style: 'display:flex;justify-content:center;margin:6px 0' }, ribbon(doc, 44, 'Challenge')));
			const resultText =
				a.perfect && b.perfect ? 'Both finished it' : a.perfect ? `${mine.name} finished first` : b.perfect ? `${other.name} finished first` : `Started ${new Date(c.startedAt).toLocaleDateString()}`;
			vs.append(el(doc, 'div', { class: 'o2ap-sub' }, resultText));
			box.append(el(doc, 'div', { class: 'o2ap-row', style: 'align-items:flex-start' }, side(mine, a, BLUE, ` - ${hours} h`, false), vs, side(other, b, ORANGE, '', true)));

			// bars per day
			const days = 6;
			const ca = cumulativeByDay(a, days);
			const cb = cumulativeByDay(b, days);
			const chart = el(doc, 'div', { style: 'display:flex;align-items:flex-end;gap:14px;height:180px;margin:18px 0 6px;padding:0 6px;border-bottom:1px solid rgba(255,255,255,.12)' });
			ca.forEach((d, i) => {
				chart.append(
					el(
						doc,
						'div',
						{ style: 'flex:1;display:flex;flex-direction:column;align-items:center;gap:4px' },
						el(
							doc,
							'div',
							{ style: 'display:flex;align-items:flex-end;gap:3px;height:160px' },
							el(doc, 'div', { title: `${mine.name} ${d.pct}%`, style: `width:22px;height:${Math.max(2, d.pct * 1.6)}px;background:${BLUE}` }),
							el(doc, 'div', { title: `${other.name} ${cb[i].pct}%`, style: `width:22px;height:${Math.max(2, cb[i].pct * 1.6)}px;background:${ORANGE}` }),
						),
						el(doc, 'div', { class: 'o2ap-sub' }, d.label),
					),
				);
			});
			box.append(chart);

			// what each one unlocked most recently
			const recent = (p: Progress) => p.list.filter((x) => x.done).sort((x, y) => y.at - x.at).slice(0, 24);
			const iconBox = (p: Progress, title: string) => {
				const wrap = el(doc, 'div', { style: 'flex:1;min-width:0' }, el(doc, 'div', { class: 'o2ap-sub', style: 'margin-bottom:4px' }, title));
				const list = el(doc, 'div', { class: 'o2ap-list' });
				recent(p).forEach((x) => list.append(el(doc, 'img', { src: x.icon, title: `${x.name} - ${x.desc}` })));
				wrap.append(list);
				return wrap;
			};
			box.append(el(doc, 'div', { style: 'display:flex;gap:18px;margin-top:10px' }, iconBox(a, `${mine.name}: ${a.done}/${a.total}`), iconBox(b, `${other.name}: ${b.done}/${b.total}`)));
			box.append(
				el(doc, 'div', { style: 'margin-top:14px' }, el(doc, 'div', {}, `YOU: ${a.percent}%`), pctBar(doc, a.percent, BLUE)),
				el(doc, 'div', { style: 'margin-top:8px' }, el(doc, 'div', {}, `${other.name.toUpperCase()}: ${b.percent}%`), pctBar(doc, b.percent, ORANGE)),
			);
			box.append(
				el(
					doc,
					'button',
					{
						class: 'o2ap-btn',
						onclick: () => {
							state.saved.challenges = state.saved.challenges.filter((x) => x.id !== c.id);
							persist();
							notify();
							closeModal(doc);
							scanAll();
						},
					},
					'End this challenge',
				),
			);
		})();
	});
}

/** the panel on the game page (under Achievements) */
async function renderChallengePanel(doc: Document, appid: string) {
	const sec = [...doc.querySelectorAll('.AppDetailsSection')].find((s) => /^achievements/i.test(s.querySelector('.SectionHeader')?.textContent?.trim() ?? '')) as HTMLElement | undefined;
	if (!sec) return;
	const mine = challengeFor(appid);
	let panel = doc.getElementById('o2ap-challenge-panel');
	if (!mine.length) return void panel?.remove();
	if (!panel) {
		panel = el(doc, 'div', { id: 'o2ap-challenge-panel', class: 'o2ap-section' });
		sec.insertAdjacentElement('afterend', panel);
	}
	const key = mine.map((c) => c.id).join(',');
	if (panel.dataset.key === key && Date.now() - Number(panel.dataset.t ?? 0) < 60000) return;
	panel.dataset.key = key;
	panel.dataset.t = String(Date.now());
	panel.innerHTML = '';
	panel.append(el(doc, 'div', { class: 'o2ap-sechead' }, 'Achievement Challenge'));
	const my = me();
	const myP = await progressOf(appid, my.id);
	for (const c of mine) {
		const other = friendById(c.friendId) ?? { id: c.friendId, name: c.friendName, avatar: '' };
		const p = await progressOf(appid, other.id);
		const mp = myP?.percent ?? 0;
		const fp = p?.percent ?? 0;
		const card = el(doc, 'div', { class: 'o2ap-card', style: 'margin-bottom:8px', onclick: () => void openComparison(doc, c) });
		card.append(
			el(
				doc,
				'div',
				{ class: 'o2ap-row' },
				el(doc, 'img', { class: 'o2ap-face', src: my.avatar }),
				el(doc, 'div', {}, el(doc, 'div', { class: 'o2ap-big', style: `color:${BLUE}` }, `${mp}%`), el(doc, 'div', { class: 'o2ap-sub' }, `${appInfo(appid).hours} hours`)),
				el(doc, 'div', { style: 'display:flex;flex-direction:column;align-items:center' }, ribbon(doc, 34, 'Challenge'), el(doc, 'b', {}, 'VS')),
				el(doc, 'div', { style: 'text-align:right' }, el(doc, 'div', { class: 'o2ap-big', style: `color:${ORANGE}` }, p ? `${fp}%` : '?'), el(doc, 'div', { class: 'o2ap-sub' }, other.name)),
				el(doc, 'img', { class: 'o2ap-face', src: other.avatar }),
			),
			el(doc, 'div', { class: 'o2ap-sub', style: 'margin-top:6px' }, 'you'),
			pctBar(doc, mp, BLUE),
			el(doc, 'div', { class: 'o2ap-sub', style: 'margin-top:6px' }, other.name),
			pctBar(doc, fp, ORANGE),
		);
		panel.append(card);
		// finished? remember who got there first
		if (!c.finished && myP && p && (myP.perfect || p.perfect)) {
			c.finished = { winner: myP.perfect && !p.perfect ? 'me' : !myP.perfect && p.perfect ? 'friend' : 'me', at: Date.now() };
			persist();
		}
	}
}

// ---------------------------------------------------------------- friends chart

async function openFriendsChart(doc: Document, appid: string, appName: string) {
	openModal(doc, (box) => {
		box.append(el(doc, 'h2', { class: 'o2ap-title' }, appName), el(doc, 'div', { class: 'o2ap-sub', style: 'text-align:center;letter-spacing:.06em' }, 'NUMBER OF ACHIEVERS WITH YOUR FRIENDS'), state.saved.perfectCount !== null ? el(doc, 'div', { class: 'o2ap-sub', style: 'text-align:center;margin-top:4px' }, 'Your perfect games: ' + state.saved.perfectCount) : null);
		const tabs = el(doc, 'div', { style: 'display:flex;gap:6px;margin:10px 0' });
		const body = el(doc, 'div', {});
		const bFriend = el(doc, 'button', { class: 'o2ap-btn o2ap-sel' }, 'FRIEND');
		const bWorld = el(doc, 'button', { class: 'o2ap-btn' }, 'WORLD');
		tabs.append(bFriend, bWorld);
		box.append(tabs, body);
		const rows: { f: FriendInfo; p: Progress }[] = [];
		const mineId = mySteamId();
		let worldList: Ach[] = [];

		const drawFriends = () => {
			body.innerHTML = '';
			const sorted = rows.slice().sort((x, y) => y.p.percent - x.p.percent);
			const chart = el(doc, 'div', { style: 'display:flex;align-items:flex-end;gap:10px;height:300px;padding:10px 4px;background:rgba(0,0,0,.25);border-radius:6px;overflow-x:auto' });
			sorted.forEach((r) => {
				const col = el(doc, 'div', { style: 'display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:3px;height:100%;min-width:34px', title: `${r.f.name}: ${r.p.done}/${r.p.total} (${r.p.percent}%)` });
				const face = el(doc, 'div', { style: 'position:relative' }, el(doc, 'img', { src: r.f.avatar, style: 'width:30px;height:30px;border-radius:3px' }));
				if (r.p.perfect) face.append(Object.assign(ribbon(doc, 14, '100%'), { className: 'o2ap-badge o2ap-avbadge' }));
				col.append(face, el(doc, 'div', { style: `width:26px;height:${Math.max(3, r.p.percent * 2.3)}px;background:${r.f.id === mineId ? ORANGE : '#62bdf5'}` }), el(doc, 'div', { class: 'o2ap-sub' }, `${r.p.percent}`));
				chart.append(col);
			});
			body.append(chart, el(doc, 'div', { class: 'o2ap-sub', style: 'margin-top:6px' }, `${sorted.length} people with public achievements. Orange = you.`));
		};
		const drawWorld = () => {
			body.innerHTML = '';
			const buckets = new Array(10).fill(0);
			worldList.forEach((a) => buckets[Math.min(9, Math.floor(a.global / 10))]++);
			const max = Math.max(1, ...buckets);
			const chart = el(doc, 'div', { style: 'display:flex;align-items:flex-end;gap:10px;height:260px;padding:10px;background:rgba(0,0,0,.25);border-radius:6px' });
			buckets.forEach((n, i) =>
				chart.append(
					el(
						doc,
						'div',
						{ style: 'flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:4px;height:100%' },
						el(doc, 'div', { class: 'o2ap-sub' }, String(n)),
						el(doc, 'div', { style: `width:100%;height:${Math.max(3, (n / max) * 190)}px;background:#62bdf5` }),
						el(doc, 'div', { class: 'o2ap-sub' }, `${i * 10}-${i * 10 + 10}%`),
					),
				),
			);
			body.append(chart, el(doc, 'div', { class: 'o2ap-sub', style: 'margin-top:6px' }, 'How many of this game\'s achievements were unlocked by that share of all players (rare on the left).'));
		};
		bFriend.onclick = () => {
			bFriend.classList.add('o2ap-sel');
			bWorld.classList.remove('o2ap-sel');
			drawFriends();
		};
		bWorld.onclick = () => {
			bWorld.classList.add('o2ap-sel');
			bFriend.classList.remove('o2ap-sel');
			drawWorld();
		};

		body.append(el(doc, 'div', { class: 'o2ap-sub', id: 'o2ap-chart-note', style: 'padding:30px;text-align:center' }, 'Loading your friends...'));
		const everyone = [me(), ...friends()];
		let checked = 0;
		const queue = everyone.slice();
		const worker = async () => {
			while (queue.length) {
				const f = queue.shift()!;
				const p = await progressOf(appid, f.id);
				checked++;
				if (p) {
					rows.push({ f, p });
					if (f.id === mineId) worldList = p.list;
				}
				const note = doc.getElementById('o2ap-chart-note');
				if (note) note.textContent = `Loading your friends... ${checked}/${everyone.length}`;
			}
		};
		void Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]).then(() => {
			if (!doc.getElementById('o2ap-modal')) return;
			if (bFriend.classList.contains('o2ap-sel')) drawFriends();
		});
	});
}

// ---------------------------------------------------------------- buttons on the game page and the achievements page

function addButtons(doc: Document, appid: string) {
	const appName = appInfo(appid).name;
	// game page: in the Achievements section, next to "View My Achievements"
	const sec = [...doc.querySelectorAll('.AppDetailsSection')].find((s) => /^achievements/i.test(s.querySelector('.SectionHeader')?.textContent?.trim() ?? ''));
	if (sec && !sec.querySelector('.o2ap-btnrow')) {
		const row = el(doc, 'div', { class: 'o2ap-btnrow', style: 'padding:0 10px 8px' });
		row.append(
			el(doc, 'button', { class: 'o2ap-btn', onclick: () => openFriendPicker(doc, appid, appName) }, 'Challenge a friend'),
			el(doc, 'button', { class: 'o2ap-btn', onclick: () => void openFriendsChart(doc, appid, appName) }, 'Friends chart'),
		);
		const body = sec.querySelector('.AppDetailsSectionContainer');
		body?.append(row);
	}
	// achievements page: inside the compare box
	const compare = doc.querySelector('.FriendCompareBox') as HTMLElement | null;
	if (compare && !compare.querySelector('.o2ap-btnrow')) {
		const pageApp = fiberProp(doc.querySelector('.AchievementsPageContainer') ?? compare, ['appid'], 30);
		const id = pageApp ? String(pageApp) : appid;
		if (id) {
			const name = appInfo(id).name;
			const row = el(doc, 'span', { class: 'o2ap-btnrow', style: 'margin-left:10px;white-space:nowrap' });
			row.append(
				el(doc, 'button', { class: 'o2ap-btn', onclick: () => openFriendPicker(doc, id, name) }, 'Challenge a friend'),
				el(doc, 'button', { class: 'o2ap-btn', onclick: () => void openFriendsChart(doc, id, name) }, 'Friends chart'),
			);
			compare.append(row);
		}
	}
}

// ---------------------------------------------------------------- activity cards

async function renderFeedCards(doc: Document, appid: string) {
	if (!state.saved.feedCards) return;
	const feed = (doc.querySelector('.ActivityFeedContainer .ViewLastNews') ?? doc.querySelector('.ActivityFeedContainer .PostTextEntry'))?.parentElement as HTMLElement | null | undefined;
	if (!feed) return;
	const anchor = (feed.querySelector('.ViewLastNews') ?? feed.querySelector('.PostTextEntry')) as HTMLElement | null;
	if (!anchor) return;
	if (feed.dataset.o2apCards === appid) return;
	feed.dataset.o2apCards = appid;
	feed.querySelectorAll('.o2ap-feed').forEach((n) => n.remove());
	const appName = appInfo(appid).name;
	const cards: HTMLElement[] = [];

	// challenge results
	for (const c of challengeFor(appid)) {
		if (!c.finished) continue;
		const winner = c.finished.winner === 'me' ? me().name : c.friendName;
		const loser = c.finished.winner === 'me' ? c.friendName : me().name;
		cards.push(
			el(doc, 'div', { class: 'o2ap-feed' }, ribbon(doc, 56, 'Challenge'), el(doc, 'div', {}, el(doc, 'h3', {}, `${winner} won the perfect game race against ${loser}`), el(doc, 'div', { class: 'o2ap-sub' }, `Challenge started ${new Date(c.startedAt).toLocaleDateString()}.`))),
		);
	}

	// friends who finished the game (only friends Steam shows in "Friends who play")
	const seen = new Set<string>();
	const entries = [...doc.querySelectorAll('.FriendsSection .AvatarAndLabel, .FriendsSection .OverflowBoxContent > .Panel')];
	for (const entry of entries) {
		const id = friendIdOfElement(entry);
		if (!id || seen.has(id)) continue;
		seen.add(id);
		const p = await progressOf(appid, id);
		if (!p?.perfect) continue;
		const f = friendById(id);
		if (!f) continue;
		const last = p.list.filter((a) => a.at).sort((x, y) => y.at - x.at)[0];
		const icons = el(doc, 'div', { style: 'display:flex;gap:4px;margin-top:6px' });
		p.list
			.filter((a) => a.done)
			.sort((x, y) => x.global - y.global)
			.slice(0, 5)
			.forEach((a) => icons.append(el(doc, 'img', { src: a.icon, title: a.name, style: 'width:34px;height:34px;border-radius:3px' })));
		cards.push(
			el(
				doc,
				'div',
				{ class: 'o2ap-feed' },
				ribbon(doc, 56, '100%'),
				el(
					doc,
					'div',
					{},
					el(doc, 'div', { class: 'o2ap-sub' }, `${f.name} achieved${last ? ' - ' + new Date(last.at * 1000).toLocaleDateString() : ''}`),
					el(doc, 'h3', {}, `${f.name} got %100 in ${appName}`),
					el(doc, 'div', { class: 'o2ap-sub' }, `${p.done}/${p.total} achievements`),
					icons,
				),
			),
		);
		if (cards.length >= 4) break;
	}
	// Steam redraws this block while the friends load, so put the cards into the one that is on screen now
	const liveFeed = (doc.querySelector('.ActivityFeedContainer .ViewLastNews') ?? doc.querySelector('.ActivityFeedContainer .PostTextEntry'))?.parentElement as HTMLElement | null | undefined;
	const liveAnchor = (liveFeed?.querySelector('.ViewLastNews') ?? liveFeed?.querySelector('.PostTextEntry')) as HTMLElement | null;
	if (!liveFeed || !liveAnchor) return;
	liveFeed.querySelectorAll('.o2ap-feed').forEach((n) => n.remove());
	liveFeed.dataset.o2apCards = appid;
	cards.reverse().forEach((c) => liveAnchor.insertAdjacentElement('afterend', c));
}

// ---------------------------------------------------------------- scanning pages

const docs = new Set<Document>();
function trace(e: any) {
	W.__o2ap_err = String(e?.stack ?? e);
}

function scan(doc: Document) {
	try {
		ensureStyle(doc);
		decorateStatsBar(doc);
		const appid = appIdOfPage(doc);
		if (!appid) return;
		decorateFriendAvatars(doc);
		addButtons(doc, appid);
		renderChallengePanel(doc, appid).catch(trace);
		renderFeedCards(doc, appid).catch(trace);
	} catch {}
}

function scanAll() {
	docs.forEach((d) => {
		d.querySelectorAll('[data-o2ap-cards]').forEach((b) => delete (b as HTMLElement).dataset.o2apCards);
		const panel = d.getElementById('o2ap-challenge-panel');
		if (panel) panel.dataset.key = '';
		scan(d);
	});
}

function attachPopup(popup: any) {
	try {
		const win: Window = popup?.m_popup ?? popup?.window ?? popup;
		const doc = win?.document;
		if (!doc || (doc as any).__o2apAttached) return;
		(doc as any).__o2apAttached = true;
		docs.add(doc);
		let timer: any = 0;
		const obs = new MutationObserver(() => {
			clearTimeout(timer);
			timer = setTimeout(() => scan(doc), 300);
		});
		const start = () => {
			if (!doc.body) return void setTimeout(start, 300);
			obs.observe(doc.body, { childList: true, subtree: true });
			scan(doc);
		};
		start();
	} catch {}
}

// ---------------------------------------------------------------- notices

function toast(text: string) {
	docs.forEach((d) => {
		if (!d.querySelector('.GameStatRight, .LibraryPage, #root')) return;
		ensureStyle(d);
		const t = el(d, 'div', { class: 'o2ap-toast' }, ribbon(d, 30, ''), el(d, 'div', {}, text));
		(d.body || d.documentElement).appendChild(t);
		setTimeout(() => t.remove(), 12000);
	});
}

/** every couple of minutes: has anyone in a running challenge reached 100%? */
async function watchChallenges() {
	const mine = mySteamId();
	let changed = false;
	for (const c of state.saved.challenges) {
		if (c.finished) continue;
		const [a, b] = await Promise.all([progressOf(c.appid, mine, true), progressOf(c.appid, c.friendId, true)]);
		if (!a || !b || !(a.perfect || b.perfect)) continue;
		const winner = a.perfect && !b.perfect ? 'me' : !a.perfect && b.perfect ? 'friend' : 'me';
		c.finished = { winner, at: Date.now() };
		changed = true;
		toast(winner === 'me' ? 'You finished ' + c.appName + ' first - challenge won against ' + c.friendName + '!' : c.friendName + ' finished ' + c.appName + ' first.');
	}
	if (changed) {
		persist();
		notify();
		scanAll();
	}
}

// ---------------------------------------------------------------- perfect games count

async function countPerfectGames() {
	const mine = mySteamId();
	let apps: any[] = [];
	try {
		apps = [...appStore.allApps].filter((a: any) => a.app_type === 1);
	} catch {}
	const total = apps.length;
	let done = 0;
	let perfect = 0;
	const queue = apps.slice();
	const worker = async () => {
		while (queue.length) {
			const a = queue.shift();
			const p = await progressOf(String(a.appid), mine);
			if (p?.perfect) perfect++;
			done++;
			state.scanProgress = `Checking your games... ${done}/${total} - ${perfect} perfect so far`;
			if (done % 10 === 0) notify();
		}
	};
	await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
	state.saved.perfectCount = perfect;
	state.saved.perfectCountAt = Date.now();
	state.scanProgress = '';
	persist();
	notify();
}

// ---------------------------------------------------------------- settings panel

function Panel() {
	const React = W.SP_REACT;
	const { DialogButton, PanelSection, PanelSectionRow, ToggleField } = W.MILLENNIUM_API;
	const [, force] = React.useReducer((x: number) => x + 1, 0);
	React.useEffect(() => {
		state.listeners.add(force);
		return () => {
			state.listeners.delete(force);
		};
	}, []);
	const h = React.createElement;
	const set = (k: keyof Saved, v: boolean) => {
		(state.saved as any)[k] = v;
		persist();
		force();
		docs.forEach((d) => {
			d.querySelectorAll('.o2ap-badge').forEach((b) => b.remove());
			d.querySelectorAll('[data-o2ap-app]').forEach((n) => delete (n as HTMLElement).dataset.o2apApp);
			d.querySelectorAll('[data-o2ap-cards]').forEach((b) => delete (b as HTMLElement).dataset.o2apCards);
			d.querySelectorAll('.o2ap-feed').forEach((b) => b.remove());
			scan(d);
		});
	};
	const toggle = (label: string, k: keyof Saved) =>
		h(PanelSectionRow, null, ToggleField ? h(ToggleField, { label, checked: !!state.saved[k], onChange: (v: boolean) => set(k, v) }) : h(DialogButton, { onClick: () => set(k, !state.saved[k]) }, `${label}: ${state.saved[k] ? 'on' : 'off'}`));
	return h(
		PanelSection,
		{ title: 'o2steam Achievement Plus' },
		toggle('Ribbon in the game stats bar', 'ribbonStats'),
		toggle('Ribbon on friends who finished the game', 'ribbonFriends'),
		toggle('Activity cards (finished games, challenges)', 'feedCards'),
		h(PanelSectionRow, null, h('div', { style: { fontSize: 13 } }, `Your perfect games: ${state.saved.perfectCount === null ? 'not counted yet' : state.saved.perfectCount}${state.saved.perfectCountAt ? ` (counted ${new Date(state.saved.perfectCountAt).toLocaleString()})` : ''}`)),
		state.scanProgress ? h(PanelSectionRow, null, h('div', { style: { fontSize: 12, opacity: 0.8 } }, state.scanProgress)) : null,
		h(PanelSectionRow, null, h(DialogButton, { onClick: () => void countPerfectGames(), disabled: !!state.scanProgress }, 'Count my perfect games')),
		h(PanelSectionRow, null, h('div', { style: { fontSize: 12, fontWeight: 600, marginTop: 8 } }, `Challenges (${state.saved.challenges.length})`)),
		...state.saved.challenges.map((c) =>
			h(
				PanelSectionRow,
				{ key: c.id },
				h(DialogButton, { onClick: () => { state.saved.challenges = state.saved.challenges.filter((x) => x.id !== c.id); persist(); force(); scanAll(); } }, `End: ${c.appName} vs ${c.friendName}`),
			),
		),
	);
}

export default async function PluginMain() {
	loadSaved();
	try {
		Array.from(g_PopupManager.GetPopups()).forEach(attachPopup);
		g_PopupManager.AddPopupCreatedCallback(attachPopup);
	} catch {}
	setTimeout(() => void watchChallenges().catch(trace), 20000);
	setInterval(() => void watchChallenges().catch(trace), 3 * 60 * 1000);
	W.__o2ap = { toast, progressOf, mySteamId, state, scanAll, countPerfectGames, renderFeedCards, appIdOfPage, friendIdOfElement, friendById, friends, me };

	return {
		title: 'o2steam Achievement Plus',
		icon: W.SP_REACT.createElement('span', null, 'o2'),
		content: W.SP_REACT.createElement(Panel),
	};
}
