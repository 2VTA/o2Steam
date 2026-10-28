/**
 * o2steam Trade Stacks
 *
 * On a trade offer page (steamcommunity.com/tradeoffer/new), adds a "Stacked view" button above the inventory.
 * It shows the open inventory as one tile per kind of item with the amount in a badge (1147 keys = one tile
 * showing 1147), and clicking a tile asks how many to put into the offer. The items are moved with Steam's own
 * MoveItemToTrade(), so the offer behaves exactly as if you had dragged them one by one. Nothing is sent: you
 * still press Make Offer yourself.
 */

const W = window as any;
const MAX_PER_SIDE = 256; // Steam's limit for one side of an offer

interface Stack {
	key: string;
	name: string;
	icon: string;
	border: string;
	background: string;
	elements: HTMLElement[]; // items of this kind still sitting in the inventory (not yet in the offer)
}

function isTradeOfferPage() {
	return location.hostname.endsWith('steamcommunity.com') && location.pathname.startsWith('/tradeoffer/');
}

function pageReady() {
	return !!(W.g_ActiveInventory && W.MoveItemToTrade && W.UserYou && document.getElementById('inventories'));
}

function itemKey(rgItem: any): string {
	return `${rgItem.classid}_${rgItem.instanceid ?? 0}`;
}

function collectStacks(): Stack[] {
	const inventory = W.g_ActiveInventory;
	// once the whole inventory is loaded every real item has an element, even on pages never opened
	const assets: any[] = Object.values(inventory?.m_rgAssets ?? {});
	const map = new Map<string, Stack>();

	for (const asset of assets) {
		const el: HTMLElement | undefined = asset?.element?.[0] ?? asset?.element;
		const rgItem = (el as any)?.rgItem ?? asset;
		if (!el || !rgItem || !rgItem.classid || rgItem.is_currency) continue;
		if (!el.closest('.itemHolder')) continue; // already moved into the offer
		if (rgItem.tradable === 0 || rgItem.description?.tradable === 0) continue;

		const key = itemKey(rgItem);
		let stack = map.get(key);
		if (!stack) {
			const img = el.querySelector('img') as HTMLImageElement | null;
			stack = {
				key,
				name: String(rgItem.name ?? rgItem.description?.name ?? 'Item'),
				icon: img?.src ?? '',
				border: el.style.borderColor,
				background: el.style.backgroundColor,
				elements: [],
			};
			map.set(key, stack);
		}
		stack.elements.push(el);
	}

	return [...map.values()].sort((a, b) => b.elements.length - a.elements.length);
}

function currentSideCount(): number {
	return document.querySelectorAll('#your_slots .item, #their_slots .item').length;
}

function addToOffer(stack: Stack, amount: number, done: (added: number) => void) {
	const queue = stack.elements.slice(0, amount);
	let added = 0;
	const step = () => {
		const el = queue.shift();
		if (!el) return done(added);
		try {
			W.MoveItemToTrade(el);
			added++;
		} catch {}
		setTimeout(step, 20);
	};
	step();
}

function injectStyles() {
	if (document.getElementById('o2stack-style')) return;
	const style = document.createElement('style');
	style.id = 'o2stack-style';
	style.textContent = `
		#o2stack-bar { margin: 8px 0; display: flex; gap: 8px; align-items: center; }
		#o2stack-toggle { cursor: pointer; padding: 6px 14px; border-radius: 3px; background: #2a475e; color: #fff; border: 0; font-size: 13px; }
		#o2stack-toggle.on { background: #66c0f4; color: #0b1d2a; }
		#o2stack-panel { display: none; flex-wrap: wrap; gap: 6px; padding: 8px; background: rgba(0,0,0,.35); border-radius: 4px; max-height: 420px; overflow-y: auto; margin-bottom: 8px; }
		#o2stack-panel.on { display: flex; }
		.o2stack-tile { position: relative; width: 72px; height: 72px; border: 2px solid #555; border-radius: 3px; cursor: pointer; box-sizing: border-box; background: #2b2b2b; }
		.o2stack-tile img { width: 100%; height: 100%; object-fit: contain; }
		.o2stack-tile:hover { outline: 2px solid #66c0f4; }
		.o2stack-badge { position: absolute; top: 2px; left: 2px; background: rgba(35, 87, 126, .95); color: #fff; font-size: 12px; font-weight: 700; padding: 0 5px; border-radius: 3px; line-height: 17px; box-shadow: 0 0 0 1px rgba(0,0,0,.4); }
		#o2stack-picker { position: fixed; z-index: 99999; background: #1b2838; border: 1px solid #66c0f4; border-radius: 4px; padding: 10px; color: #fff; width: 210px; box-shadow: 0 4px 18px rgba(0,0,0,.6); font-size: 13px; }
		#o2stack-picker input { width: 70px; background: #0e1722; color: #fff; border: 1px solid #3a4a5c; padding: 3px 5px; }
		#o2stack-picker button { cursor: pointer; margin: 6px 4px 0 0; padding: 4px 10px; border: 0; border-radius: 3px; background: #2a475e; color: #fff; }
		#o2stack-picker button.primary { background: #66c0f4; color: #0b1d2a; }
		#o2stack-empty { color: #aaa; padding: 12px; }
	`;
	document.head.appendChild(style);
}

function closePicker() {
	document.getElementById('o2stack-picker')?.remove();
}

function openPicker(stack: Stack, anchor: HTMLElement, onAdded: () => void) {
	closePicker();
	const room = Math.max(0, MAX_PER_SIDE - currentSideCount());
	const max = Math.min(stack.elements.length, room || stack.elements.length);

	const box = document.createElement('div');
	box.id = 'o2stack-picker';
	const rect = anchor.getBoundingClientRect();
	box.style.left = `${Math.min(rect.left, window.innerWidth - 230)}px`;
	box.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - 150)}px`;
	box.innerHTML = `<div style="margin-bottom:6px"><b></b><br><span style="opacity:.7">${stack.elements.length} available</span></div>
		<input type="number" min="1" max="${max}" value="1"> <span style="opacity:.7">of ${max}</span><br>
		<button data-act="all">All</button><button class="primary" data-act="add">Add</button><button data-act="cancel">Cancel</button>
		<div id="o2stack-note" style="margin-top:6px;opacity:.7;font-size:11px"></div>`;
	(box.querySelector('b') as HTMLElement).textContent = stack.name;
	const input = box.querySelector('input') as HTMLInputElement;
	const note = box.querySelector('#o2stack-note') as HTMLElement;
	if (room < stack.elements.length) note.textContent = `Steam allows ${MAX_PER_SIDE} items per side, so up to ${max} fit.`;

	box.addEventListener('click', (e) => {
		const act = (e.target as HTMLElement).dataset?.act;
		if (!act) return;
		if (act === 'cancel') return closePicker();
		if (act === 'all') input.value = String(max);
		const amount = Math.max(1, Math.min(max, parseInt(input.value, 10) || 1));
		closePicker();
		addToOffer(stack, amount, () => onAdded());
	});
	input.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') (box.querySelector('[data-act=add]') as HTMLElement).click();
		if (e.key === 'Escape') closePicker();
	});

	document.body.appendChild(box);
	input.focus();
	input.select();
}

function mount() {
	if (document.getElementById('o2stack-bar')) return;
	injectStyles();

	const inventories = document.getElementById('inventories') as HTMLElement;
	const bar = document.createElement('div');
	bar.id = 'o2stack-bar';
	const toggle = document.createElement('button');
	toggle.id = 'o2stack-toggle';
	toggle.textContent = 'Stacked view';
	bar.appendChild(toggle);
	const panel = document.createElement('div');
	panel.id = 'o2stack-panel';
	inventories.parentElement!.insertBefore(bar, inventories);
	inventories.parentElement!.insertBefore(panel, inventories);

	let lastSignature = '';
	const render = (force = false) => {
		if (!panel.classList.contains('on')) return;
		const stacks = collectStacks();
		const signature = `${W.g_ActiveInventory?.m_strCompositeID ?? ''}|${stacks.map((s) => `${s.key}:${s.elements.length}`).join(',')}`;
		if (!force && signature === lastSignature) return;
		lastSignature = signature;

		panel.textContent = '';
		if (!stacks.length) {
			const empty = document.createElement('div');
			empty.id = 'o2stack-empty';
			empty.textContent = 'Nothing tradable to show here (the inventory may still be loading).';
			panel.appendChild(empty);
			return;
		}
		for (const stack of stacks) {
			const tile = document.createElement('div');
			tile.className = 'o2stack-tile';
			tile.title = `${stack.name} (${stack.elements.length})`;
			if (stack.border) tile.style.borderColor = stack.border;
			if (stack.background) tile.style.backgroundColor = stack.background;
			const img = document.createElement('img');
			img.src = stack.icon;
			tile.appendChild(img);
			if (stack.elements.length > 1) {
				const badge = document.createElement('div');
				badge.className = 'o2stack-badge';
				badge.textContent = String(stack.elements.length);
				tile.appendChild(badge);
			}
			tile.addEventListener('click', () => openPicker(stack, tile, () => render(true)));
			panel.appendChild(tile);
		}
	};

	// Steam loads a big inventory in pieces as you flip pages; ask for all of it so the counts are complete
	const loadWholeInventory = (): Promise<void> =>
		new Promise((resolve) => {
			try {
				const pending = W.g_ActiveInventory.LoadCompleteInventory();
				if (pending?.done) pending.done(() => resolve());
				else if (pending?.then) pending.then(() => resolve());
				else resolve();
			} catch {
				resolve();
			}
		});

	toggle.addEventListener('click', async () => {
		const on = !panel.classList.contains('on');
		panel.classList.toggle('on', on);
		toggle.classList.toggle('on', on);
		toggle.textContent = on ? 'Stacked view: on' : 'Stacked view';
		closePicker();
		if (!on) return;

		panel.textContent = 'Loading the whole inventory...';
		await loadWholeInventory();
		render(true);
	});

	// the trade changes and the inventory switches without us being told, so just look again now and then
	setInterval(() => render(false), 700);
}

export default async function WebkitMain() {
	if (!isTradeOfferPage()) return;
	const wait = setInterval(() => {
		if (!pageReady()) return;
		clearInterval(wait);
		mount();
	}, 500);
}
