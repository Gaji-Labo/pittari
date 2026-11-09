import { formatDelta } from "./report.mjs";

// Figma の get_metadata が返すノードの箱と、実装の DOM の箱を要素ごとに突き合わせる。
// design-diff.mjs から使う。画素差分は面積の小さいずれを薄めてしまうので、配置はこちらで判定する

// ---- Figma 側 ----

const TAG_PATTERN = /<(\/?)([\w-]+)((?:\s+[\w-]+="[^"]*")*)\s*(\/?)>/g;
const ATTRIBUTE_PATTERN = /([\w-]+)="([^"]*)"/g;

function parseTree(xml) {
	const stack = [];
	let root = null;
	for (const match of xml.matchAll(TAG_PATTERN)) {
		const [, closing, type, attributeText, selfClosing] = match;
		if (closing) {
			stack.pop();
			continue;
		}
		const attributes = Object.fromEntries([...attributeText.matchAll(ATTRIBUTE_PATTERN)].map(([, key, value]) => [key, value]));
		const node = {
			id: attributes.id,
			name: attributes.name,
			type,
			hidden: attributes.hidden === "true",
			x: Number(attributes.x),
			y: Number(attributes.y),
			width: Number(attributes.width),
			height: Number(attributes.height),
			children: [],
		};
		const parent = stack.at(-1);
		if (parent) parent.children.push(node);
		else root ??= node;
		if (!selfClosing) stack.push(node);
	}
	return root;
}

function indexById(node, index = new Map()) {
	index.set(node.id, node);
	for (const child of node.children) indexById(child, index);
	return index;
}

// get_metadata はインスタンスの内部を返さないので、インスタンス単位で呼び足した XML を同じ id のノードへ差し込む
export function parseMetadata(xmlTexts) {
	const trees = xmlTexts.map(parseTree);
	const empty = trees.findIndex((tree) => tree === null);
	if (empty !== -1) throw new Error(`${empty + 1} 番目の --metadata にノードが無い`);
	const [main, ...extras] = trees;
	const warnings = [];
	for (const extra of extras) {
		// 入れ子のインスタンスは外側のインスタンスを差し込んだ後にしか見つからないので、差し込むたびに索引を作り直す
		const target = indexById(main).get(extra.id);
		if (!target) {
			warnings.push(`id="${extra.id}" のノードが最初の --metadata に無いので、この XML は使いません`);
			continue;
		}
		target.children = extra.children;
	}
	const nodes = [];
	// 親相対の座標をルート左上が原点の絶対座標にする。ルート自身の x, y は Figma のページ座標なので捨てる
	const flatten = (node, originX, originY, depth) => {
		if (node.hidden) return;
		const x = depth === 0 ? 0 : originX + node.x;
		const y = depth === 0 ? 0 : originY + node.y;
		nodes.push({ id: node.id, name: node.name, type: node.type, depth, x, y, width: node.width, height: node.height });
		if (node.type === "instance" && node.children.length === 0) {
			warnings.push(`インスタンス "${node.name}"（id="${node.id}"）の内部が無い。get_metadata をこの id で呼び、その出力も --metadata に渡す`);
		}
		for (const child of node.children) flatten(child, x, y, depth + 1);
	};
	flatten(main, 0, 0, 0);
	return { nodes, warnings };
}

// ---- 実装側（ブラウザ内で実行する。Playwright がソースを文字列化して渡すので、この関数の外を参照しない） ----

export function collectDomBoxes(root) {
	const rootRect = root.getBoundingClientRect();
	const boxes = [];
	const describe = (element) => {
		const className = typeof element.className === "string" ? element.className.trim() : "";
		return element.tagName.toLowerCase() + (className ? `.${className.split(/\s+/).join(".")}` : "");
	};
	const toBox = (rect) => ({ x: rect.left - rootRect.left, y: rect.top - rootRect.top, width: rect.width, height: rect.height });
	const walk = (element) => {
		const text = element.textContent.replace(/\s+/g, " ").trim();
		const box = toBox(element.getBoundingClientRect());
		// Figma の text ノードに padding 込みの要素しか対応しないことがあるので、文字に沿った箱も別に持つ。
		// Range の矩形の高さは行高ではなく字面の高さなので、Range からは横方向だけを取る
		const range = document.createRange();
		range.selectNodeContents(element);
		const rangeRect = range.getBoundingClientRect();
		boxes.push({
			label: describe(element),
			...box,
			text,
			textBox: text ? { ...box, x: rangeRect.left - rootRect.left, width: rangeRect.width } : null,
		});
		for (const child of element.children) walk(child);
	};
	walk(root);
	return boxes;
}

// ---- 対応付け ----

// 位置と寸法のずれを同じ単位で足した距離。四辺それぞれのずれの合計に相当する
const boxDistance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.width - b.width) + Math.abs(a.height - b.height);
const normalizeText = (text) => text.replace(/\s+/g, " ").trim();

function matchByText(node, boxes, text) {
	const wanted = normalizeText(text);
	const candidates = boxes.filter((box) => box.text === wanted);
	if (candidates.length === 0) return { method: "text", box: null, reason: `文字列「${wanted.slice(0, 24)}」を持つ要素が無い` };
	// 同じ文字列だけを含む祖先も候補に入るので、最も内側（面積が最小）の要素を選ぶ
	candidates.sort((a, b) => a.width * a.height - b.width * b.height);
	const element = candidates[0];
	// Figma の text ノードは幅いっぱいに広がる箱のことも文字に沿う箱のこともあり、metadata からは区別できない。
	// 要素の箱と文字幅の箱のうち近いほうを同じ要素の測り方として採る
	const textBox = element.textBox && { ...element.textBox, label: `${element.label} の文字幅`, text: element.text };
	const box = textBox && boxDistance(node, textBox) < boxDistance(node, element) ? textBox : element;
	return { method: "text", box };
}

function matchByGeometry(node, boxes, tolerance) {
	// 箱の周長の半分より離れた要素は、対応する要素ではなく別の要素とみなす
	const limit = Math.max(16, (node.width + node.height) / 2);
	const scored = boxes
		.map((box) => ({ box, distance: boxDistance(node, box) }))
		.filter((entry) => entry.distance <= limit)
		.sort((a, b) => a.distance - b.distance);
	if (scored.length === 0) return { method: "geometry", box: null, reason: "近い箱を持つ要素が無い" };
	const best = scored[0];
	// 箱の違う要素が僅差で並ぶときは、どちらへ合わせるべきかを機械では決められない
	const rival = scored.find((entry) => boxDistance(entry.box, best.box) > 1e-6 && entry.distance - best.distance <= tolerance * 2);
	return { method: "geometry", box: best.box, rival: rival?.box ?? null };
}

export function compareLayout(nodes, boxes, texts, tolerance) {
	return nodes.map((node) => {
		const text = texts[node.id];
		const match = text === undefined ? matchByGeometry(node, boxes, tolerance) : matchByText(node, boxes, text);
		const box = match.box;
		const delta = box
			? { x: box.x - node.x, y: box.y - node.y, width: box.width - node.width, height: box.height - node.height }
			: null;
		const worst = delta ? Math.max(...Object.values(delta).map(Math.abs)) : null;
		const status = !box ? "対応なし" : match.rival ? "候補が拮抗" : worst <= tolerance ? "OK" : "ずれ";
		return { node, status, method: match.method, element: box?.label ?? null, rival: match.rival?.label ?? null, reason: match.reason ?? null, delta };
	});
}

export function formatLayoutReport(results, tolerance) {
	const lines = [];
	const mismatched = results.filter((result) => result.status !== "OK");
	lines.push(
		mismatched.length === 0
			? `[箱] PASS 全 ${results.length} ノードが許容 ±${tolerance}px に収まっている`
			: `[箱] FAIL ${mismatched.length}/${results.length} ノードにずれ・未対応（許容 ±${tolerance}px、座標は対象の左上が原点、値は 実装 − Figma）`,
	);
	for (const result of results) {
		const { node } = result;
		const name = `${"  ".repeat(node.depth)}${node.name} [${node.type}]`.padEnd(40);
		if (!result.delta) {
			lines.push(`  ${name} ${result.status}: ${result.reason}`);
			continue;
		}
		const via = result.method === "text" ? "文字" : "幾何";
		const delta =
			result.status === "OK"
				? ""
				: ` x ${formatDelta(result.delta.x)}  y ${formatDelta(result.delta.y)}  w ${formatDelta(result.delta.width)}  h ${formatDelta(result.delta.height)}`;
		lines.push(`  ${name} ${result.status.padEnd(6)}${delta}  ← ${result.element}（${via}）`);
		if (result.rival) lines.push(`  ${" ".repeat(40)} 別候補: ${result.rival}`);
	}
	return lines.join("\n");
}
