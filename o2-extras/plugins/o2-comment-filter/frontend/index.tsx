/**
 * o2steam Comment Filter - Steam client part
 *
 * The filter itself runs on your profile page (see ../webkit): open your profile in Steam, and above the comments
 * there is a box where you list the words. This panel only explains that.
 */

const W = window as any;

export default async function PluginMain() {
	const h = W.SP_REACT.createElement;
	return {
		title: 'o2steam Comment Filter',
		icon: h('span', null, 'o2'),
		content: h(
			'div',
			{ style: { fontSize: 13, lineHeight: '19px', padding: '8px 4px' } },
			h('div', { style: { fontWeight: 600, marginBottom: 6 } }, 'Comment Filter'),
			h('div', null, 'Open your own profile in Steam (your name at the top, then View Profile). Above the comments there is a box:'),
			h('ul', { style: { margin: '6px 0 6px 18px' } },
				h('li', null, 'type the words you do not want to see in comments'),
				h('li', null, '"Check this page" marks the comments that contain them (red outline)'),
				h('li', null, '"Delete the matching comments" deletes them, or tick "automatically" and it deletes by itself'),
			),
			h('div', { style: { opacity: 0.75 } }, 'Only comments on the page you are looking at are checked, and your own comments are never touched. Nothing is sent anywhere.'),
		),
	};
}
