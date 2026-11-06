import { contentBounds } from "./bounds.mjs";
import { formatDelta } from "./report.mjs";

// デザイン画像の入力には Figma のノードの箱が無いので、実装側の要素の辺ごとに、デザイン画像の同じ位置に同じ境界があるかを調べる。
// design-diff.mjs から使う。画素差分は面積の小さいずれを薄めてしまうので、配置はこちらで判定する

// ---- 実装側（ブラウザ内で実行する。Playwright がソースを文字列化して渡すので、この関数の外を参照しない） ----

export function collectElementBoxes(root) {
	const rootRect = root.getBoundingClientRect();
	const elements = [];
	const describe = (element) => {
		const className = typeof element.className === "string" ? element.className.trim() : "";
		return element.tagName.toLowerCase() + (className ? `.${className.split(/\s+/).join(".")}` : "");
	};
	const toBox = (rect) => ({
		left: rect.left - rootRect.left,
		top: rect.top - rootRect.top,
		right: rect.right - rootRect.left,
		bottom: rect.bottom - rootRect.top,
	});
	// clip は祖先が切り取る範囲（ビューポート座標）。切り取る祖先が無い向きは無限遠にする
	const walk = (element, clip) => {
		const rect = element.getBoundingClientRect();
		const style = getComputedStyle(element);
		if (rect.width > 0 && rect.height > 0) {
			// 文字の外接矩形を取る範囲を、アイコンのような子要素を含まない、要素自身の文字だけに絞る
			const textNodes = [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim() !== "");
			const textRects = textNodes.flatMap((node) => {
				const range = document.createRange();
				range.selectNodeContents(node);
				return [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
			});
			// 字の端は、行の箱から斜体やアクセントの分だけはみ出すことがあるので 1px 広げる。
			// 視覚的に隠した文字（sr-only など）や祖先に切り取られた文字は描かれず、その位置には別の要素が写るので、
			// 広げたあとに要素自身と祖先の切り取る範囲で切り取る
			const clips = style.overflowX !== "visible" || style.overflowY !== "visible" || style.clip !== "auto" || style.clipPath !== "none";
			const textBox =
				textRects.length === 0
					? null
					: toBox({
							left: Math.max(Math.min(...textRects.map((r) => r.left)) - 1, clips ? rect.left : -Infinity, clip.left),
							top: Math.max(Math.min(...textRects.map((r) => r.top)) - 1, clips ? rect.top : -Infinity, clip.top),
							right: Math.min(Math.max(...textRects.map((r) => r.right)) + 1, clips ? rect.right : Infinity, clip.right),
							bottom: Math.min(Math.max(...textRects.map((r) => r.bottom)) + 1, clips ? rect.bottom : Infinity, clip.bottom),
						});
			// rounded-full の無限大の半径も、描かれる角丸は短辺の半分で頭打ちになる
			const radius = (value) => Math.min(parseFloat(value) * (value.endsWith("%") ? Math.min(rect.width, rect.height) / 100 : 1), rect.width / 2, rect.height / 2);
			// 透明な入れ物の辺に写る色は子が描いたもので、その子の辺として判定される。入れ物の辺としても照合すると、
			// 子の角丸や隙間の違いまで入れ物の位置のずれに見えるので、要素自身が描く辺だけを判定する
			const isTransparent = (color) => color === "transparent" || /,\s*0\)$/.test(color) || /\/\s*0\)$/.test(color);
			// svg はアイコンの形が箱を埋めないので、ここに含めない
			const paintsBox =
				["img", "video", "canvas", "iframe", "input", "select", "textarea"].includes(element.tagName.toLowerCase()) ||
				!isTransparent(style.backgroundColor) ||
				style.backgroundImage !== "none";
			// 祖先に切り取られてはみ出した辺の位置に見えるのは、祖先の切り取り線になる。要素の辺として照合すると、要素の位置を確かめないまま
			// OK に数え、祖先の辺がずれたときは同じずれを要素の辺でも重ねて報告するので、判定しない。
			// 0.5px の余裕は、小数の位置で祖先の内側に接している要素を、はみ出したと取り違えないため
			const clipped = {
				Top: rect.top < clip.top - 0.5,
				Bottom: rect.bottom > clip.bottom + 0.5,
				Left: rect.left < clip.left - 0.5,
				Right: rect.right > clip.right + 0.5,
			};
			const paints = (side) =>
				!clipped[side] &&
				(paintsBox || (parseFloat(style[`border${side}Width`]) > 0 && style[`border${side}Style`] !== "none" && !isTransparent(style[`border${side}Color`])));
			elements.push({
				label: describe(element),
				...toBox(rect),
				painted: { top: paints("Top"), bottom: paints("Bottom"), left: paints("Left"), right: paints("Right") },
				radii: {
					topLeft: radius(style.borderTopLeftRadius),
					topRight: radius(style.borderTopRightRadius),
					bottomRight: radius(style.borderBottomRightRadius),
					bottomLeft: radius(style.borderBottomLeftRadius),
				},
				text: textBox && textNodes.map((node) => node.textContent).join("").replace(/\s+/g, " ").trim(),
				textBox,
			});
		}
		// SVG の中の図形の箱は線幅を含まず、描かれた輪郭と一致しないので、アイコンの中身は画素差分に任せる
		if (element.tagName.toLowerCase() === "svg") return;
		// overflow は枠の内側（padding box）で、clip-path は枠の外側（border box）で子を切り取る
		const childClip = { ...clip };
		const clipsX = style.overflowX !== "visible";
		const clipsY = style.overflowY !== "visible";
		const clipsPath = style.clipPath !== "none";
		if (clipsX || clipsPath) {
			childClip.left = Math.max(clip.left, rect.left + (clipsX ? parseFloat(style.borderLeftWidth) : 0));
			childClip.right = Math.min(clip.right, rect.right - (clipsX ? parseFloat(style.borderRightWidth) : 0));
		}
		if (clipsY || clipsPath) {
			childClip.top = Math.max(clip.top, rect.top + (clipsY ? parseFloat(style.borderTopWidth) : 0));
			childClip.bottom = Math.min(clip.bottom, rect.bottom - (clipsY ? parseFloat(style.borderBottomWidth) : 0));
		}
		for (const child of element.children) walk(child, childClip);
	};
	walk(root, { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity });
	return elements;
}

// ---- 辺の照合 ----

// design-measure の --tolerance の既定値と同じ。RGB の差の合計がこれ以下なら同じ色とみなす
const COLOR_TOLERANCE = 12;
// 箱の辺の外側と内側をそれぞれこの幅（CSS px）だけ帯として切り出して照合する。広げると、辺の近くにある別の境界まで帯に入る
const EDGE_BAND = 2;
// デザイン画像で同じ境界を探す範囲（CSS px）。隣の行や罫線を同じ境界と取り違えないよう、表の行の間隔より狭くする
const SEARCH_RANGE = 8;
// 長い辺の全画素で照合すると、要素の多いセクションで時間がかかるので、辺に沿って等間隔に間引く
const MAX_SAMPLES = 256;

// 表の行のように同じずれが繰り返すと報告が長くなり、読むだけでトークンを使うので、残りは edges.json に任せる
const MAX_CONSOLE_EDGES = 30;

const SIDES = ["top", "bottom", "left", "right"];
const SIDE_NAMES = { top: "上辺", bottom: "下辺", left: "左辺", right: "右辺" };
const NOT_FOUND = `デザイン画像の ±${SEARCH_RANGE}px 以内に同じ境界が無い`;

// pixelmatch と同じく、半透明の画素は白の上に重ねた色として比べる
function rgbAt(png, x, y) {
	const i = (y * png.width + x) * 4;
	const alpha = png.data[i + 3] / 255;
	return [0, 1, 2].map((c) => png.data[i + c] * alpha + 255 * (1 - alpha));
}
const colorDistance = (p, q) => Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]);

function evenlySpaced(from, to) {
	const count = to - from;
	if (count <= MAX_SAMPLES) return Array.from({ length: count }, (_, i) => from + i);
	return Array.from({ length: MAX_SAMPLES }, (_, i) => from + Math.floor((i * count) / MAX_SAMPLES));
}

function clipBox(box, png) {
	return {
		left: Math.max(0, box.left),
		top: Math.max(0, box.top),
		right: Math.min(png.width, box.right),
		bottom: Math.min(png.height, box.bottom),
	};
}

// 角丸の外側や隣の要素の色が隅に写り込んでも左右されないよう、1 画素ではなく範囲の縁で最も多い色を背景とみなす
function backgroundOf(png, region) {
	const counts = new Map();
	const count = (x, y) => {
		const key = rgbAt(png, x, y).map(Math.round).join(",");
		counts.set(key, (counts.get(key) ?? 0) + 1);
	};
	for (let x = region.left; x < region.right; x++) {
		count(x, region.top);
		count(x, region.bottom - 1);
	}
	for (let y = region.top; y < region.bottom; y++) {
		count(region.left, y);
		count(region.right - 1, y);
	}
	return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0].split(",").map(Number);
}

// 背景との差の最大値と、各画素の背景との差を返す。除外した画素は背景と同じとして扱う
function contrastMap(png, region, isExcluded) {
	const background = backgroundOf(png, region);
	const width = region.right - region.left;
	const distances = new Float32Array(width * (region.bottom - region.top));
	let max = 0;
	for (let y = region.top; y < region.bottom; y++) {
		for (let x = region.left; x < region.right; x++) {
			if (isExcluded(x, y)) continue;
			const distance = colorDistance(rgbAt(png, x, y), background);
			distances[(y - region.top) * width + x - region.left] = distance;
			max = Math.max(max, distance);
		}
	}
	return { max, at: (x, y) => distances[(y - region.top) * width + x - region.left] };
}

// 文字の要素の箱は行高の余白を含み、辺の両側がどちらも背景になるので、字の外接矩形を辺として使う
function glyphBounds(png, region, isExcluded) {
	const background = backgroundOf(png, region);
	const content = contentBounds(region, (x, y) => (isExcluded(x, y) ? null : colorDistance(rgbAt(png, x, y), background)));
	if (content.max <= COLOR_TOLERANCE) return null;
	return { ...content.bounds, contrast: content.max };
}

// 字のある行（列）が続く範囲のうち、実装側の字の範囲と重なるものだけを集める。
// 探す範囲に入った隣の要素の字は、空白の行（列）で隔てられていて重ならないので、混ざらない。
// 字と字、語と語の間の空白は maxGap 以下なら続きとみなす。分けたままだと、デザイン画像の字が実装より広いときに、
// 実装側の字の範囲の外にある字が抜け落ちて、幅のずれを見逃す
function overlappingRuns(hasContent, from, to, actualFrom, actualTo, maxGap) {
	const runs = [];
	let start = null;
	for (let i = from; i <= to; i++) {
		if (i < to && hasContent(i)) {
			start ??= i;
			continue;
		}
		if (start === null) continue;
		const previous = runs.at(-1);
		if (previous && start - previous.end <= maxGap) previous.end = i;
		else runs.push({ start, end: i });
		start = null;
	}
	const overlapping = runs.filter((run) => run.start < actualTo && run.end > actualFrom);
	return overlapping.length === 0 ? null : { start: overlapping[0].start, end: overlapping.at(-1).end };
}

// デザイン画像の字の外接矩形を、実装側の字の外接矩形の周りで探す
function designGlyphBounds(png, actual, scale, isExcluded) {
	const search = Math.round(SEARCH_RANGE * scale);
	const window = clipBox(
		{ left: actual.left - search, top: actual.top - search, right: actual.right + search, bottom: actual.bottom + search },
		png,
	);
	if (window.right <= window.left || window.bottom <= window.top) return null;
	const contrast = contrastMap(png, window, isExcluded);
	if (contrast.max <= COLOR_TOLERANCE) return null;
	// 隣にもっと濃い要素があってもデザイン画像側の字を拾えるよう、実装側の字の濃さとの小さいほうで切る
	const threshold = Math.min(contrast.max, actual.contrast) / 2;
	const isContent = (x, y) => contrast.at(x, y) >= threshold;
	const columnsFrom = Math.max(window.left, actual.left);
	const columnsTo = Math.min(window.right, actual.right);
	const rows = overlappingRuns(
		(y) => {
			for (let x = columnsFrom; x < columnsTo; x++) if (isContent(x, y)) return true;
			return false;
		},
		window.top,
		window.bottom,
		actual.top,
		actual.bottom,
		0,
	);
	if (!rows) return null;
	const columns = overlappingRuns(
		(x) => {
			for (let y = rows.start; y < rows.end; y++) if (isContent(x, y)) return true;
			return false;
		},
		window.left,
		window.right,
		actual.left,
		actual.right,
		// 語の間の空白は字の外接矩形の高さの 1/4 ほど。それより広い空白を挟む隣のアイコンや印まで字に含めないよう、1/3 で切る
		Math.ceil((actual.bottom - actual.top) / 3),
	);
	if (!columns) return null;
	return { left: columns.start, top: rows.start, right: columns.end, bottom: rows.end, window };
}

function compareGlyphs(actual, design, scale) {
	return SIDES.map((side) => {
		let result;
		if (!design) result = { delta: null, reason: NOT_FOUND };
		// 探す範囲の端で途切れた辺は、本当の位置がさらに外にあるので、ずれの値を出せない
		else if (design[side] === design.window[side]) result = { delta: null, reason: `デザイン画像では ±${SEARCH_RANGE}px より外まで字が続く` };
		else result = { delta: (actual[side] - design[side]) / scale };
		return {
			side,
			position: actual[side],
			from: side === "top" || side === "bottom" ? actual.left : actual.top,
			to: side === "top" || side === "bottom" ? actual.right : actual.bottom,
			result,
		};
	});
}

// 箱の 4 辺を、辺に直交する軸での位置（境界の内側の最初の画素か、外側の最初の画素）と、辺に沿った範囲で表す。
// 照合には角丸を除いた直線の部分だけを使う。角丸の半径の違いは辺の位置のずれではなく、画素差分で見る中身の違いなので
function edgesOf(box, radii) {
	return [
		{ side: "top", horizontal: true, position: box.top, outward: -1, from: box.left, to: box.right, sampleFrom: box.left + radii.topLeft, sampleTo: box.right - radii.topRight },
		{ side: "bottom", horizontal: true, position: box.bottom, outward: 1, from: box.left, to: box.right, sampleFrom: box.left + radii.bottomLeft, sampleTo: box.right - radii.bottomRight },
		{ side: "left", horizontal: false, position: box.left, outward: -1, from: box.top, to: box.bottom, sampleFrom: box.top + radii.topLeft, sampleTo: box.bottom - radii.bottomLeft },
		{ side: "right", horizontal: false, position: box.right, outward: 1, from: box.top, to: box.bottom, sampleFrom: box.top + radii.topRight, sampleTo: box.bottom - radii.bottomRight },
	];
}

// 背景や枠のある箱の辺は、辺をまたぐ帯をデザイン画像の中でずらしながら照合し、最も一致する位置を境界とみなす
function measureBoxEdge(edge, designPng, actualPng, scale, isExcluded) {
	const band = Math.max(1, Math.round(EDGE_BAND * scale));
	const search = Math.round(SEARCH_RANGE * scale);
	// along は辺に沿った座標、across は辺に直交する座標
	const toXY = (along, across) => (edge.horizontal ? [along, across] : [across, along]);
	const isInside = (png, x, y) => x >= 0 && y >= 0 && x < png.width && y < png.height;
	const read = (png, along, across) => {
		const [x, y] = toXY(along, across);
		return isInside(png, x, y) && !isExcluded(x, y) ? rgbAt(png, x, y) : null;
	};
	const bandStart = edge.position - band;
	const bandEnd = edge.position + band;
	const outsideAt = edge.outward < 0 ? bandStart : bandEnd - 1;

	const columns = [];
	let readableCount = 0;
	for (const along of evenlySpaced(edge.sampleFrom, edge.sampleTo)) {
		// 帯の片側が比較から外した範囲や画像の外にかかる列は、残った片側だけでは境界の有無も位置も決まらない
		const bandColors = [];
		for (let across = bandStart; across < bandEnd; across++) bandColors.push(read(actualPng, along, across));
		if (bandColors.includes(null)) continue;
		const outside = bandColors[outsideAt - bandStart];
		readableCount++;
		// 帯の内側の端の 1 画素とだけ比べると、1px の枠線のように帯の途中にしか色の無い境界を見落とす
		const hasBoundary = bandColors.some((color) => colorDistance(color, outside) > COLOR_TOLERANCE);
		// 入れ物の一部だけに子の背景が重なる辺では、境界の無い列まで照合すると子の中身に引きずられる
		if (hasBoundary) columns.push({ along, outside });
	}
	// 透明な入れ物や背景と同色の要素の辺は、どこにあってもデザイン画像と見分けが付かない。
	// 透明な入れ物の辺に子の背景が一部だけ重なる場合は、子の辺として判定されるので、辺の半分以上で境界があるときだけ判定する
	if (columns.length === 0 || columns.length * 2 < readableCount) return null;

	const cost = (shift) => {
		let sum = 0;
		let count = 0;
		for (const { along } of columns) {
			for (let across = bandStart; across < bandEnd; across++) {
				const actual = read(actualPng, along, across);
				if (!actual) continue;
				const [x, y] = toXY(along, across + shift);
				// 帯の一部が画像の外へ出る位置は、残った僅かな画素だけで一致して見えるので候補にしない
				if (!isInside(designPng, x, y)) return Infinity;
				if (isExcluded(x, y)) continue;
				sum += colorDistance(actual, rgbAt(designPng, x, y));
				count++;
			}
		}
		return count === 0 ? Infinity : sum / count;
	};
	const costs = new Map();
	for (let shift = -search; shift <= search; shift++) costs.set(shift, cost(shift));
	// 同じ境界があれば、その位置だけ差が際立って小さくなる。デザイン画像の色が実装と少し違っても、どの位置の差も同じだけ増えるので、
	// 差の大きさそのものではなく、ずらした位置の中ほどの差との比で決める
	const comparable = [...costs.values()].filter(Number.isFinite).sort((a, b) => a - b);
	const typicalCost = comparable[Math.floor(comparable.length / 2)];
	const isMatch = (shift) => {
		const value = costs.get(shift);
		return value * 2 <= typicalCost && !(costs.get(shift - 1) < value) && !(costs.get(shift + 1) < value);
	};
	// 並んだチップのように同じ形が探す範囲に繰り返すと、隣の要素の境界とも一致する。一致した位置のうち最も近いものを採る
	let matched = null;
	for (let distance = 0; distance <= search && matched === null; distance++) {
		const candidates = [...new Set([-distance, distance])].filter(isMatch);
		if (candidates.length > 0) matched = candidates.sort((a, b) => costs.get(a) - costs.get(b))[0];
	}
	if (matched === null) return { delta: null, reason: NOT_FOUND };
	// 実装の辺がデザイン画像の境界より shift だけ手前にあるので、実装 − デザインは -shift
	return { delta: -matched / scale };
}

export function compareEdges(designPng, actualPng, elements, { scale, offset, tolerance, isExcluded }) {
	const toDeviceBox = (box) =>
		clipBox(
			{
				left: Math.round((box.left + offset.x) * scale),
				top: Math.round((box.top + offset.y) * scale),
				right: Math.round((box.right + offset.x) * scale),
				bottom: Math.round((box.bottom + offset.y) * scale),
			},
			actualPng,
		);
	const isEmpty = (box) => box.right <= box.left || box.bottom <= box.top;
	// 入れ子の要素が位置も範囲も同じ辺を持つときは、1 つの辺として 1 回だけ数える。ずれは外側の要素の名前で報告する
	const unique = new Map();
	const add = (edge, label) => {
		const key = `${edge.side}:${edge.position}:${edge.from}:${edge.to}`;
		const shared = unique.get(key);
		if (!shared) {
			unique.set(key, { ...edge, elements: [label] });
			return;
		}
		shared.elements.push(label);
		shared.painted ||= edge.painted;
		// 同じ辺を持つ要素のどれかが角丸なら、その角では境界が辺から離れて描かれるので、最も大きい角丸を除く
		shared.sampleFrom = Math.max(shared.sampleFrom, edge.sampleFrom);
		shared.sampleTo = Math.min(shared.sampleTo, edge.sampleTo);
	};
	for (const element of elements) {
		const box = toDeviceBox(element);
		if (isEmpty(box)) continue;
		const radii = Object.fromEntries(Object.entries(element.radii).map(([corner, cssPx]) => [corner, Math.ceil(cssPx * scale)]));
		for (const edge of edgesOf(box, radii)) add({ ...edge, kind: "box", painted: element.painted[edge.side] }, element.label);
		if (!element.textBox) continue;
		const textRegion = toDeviceBox(element.textBox);
		if (isEmpty(textRegion)) continue;
		const glyphs = glyphBounds(actualPng, textRegion, isExcluded);
		if (!glyphs) continue;
		const design = designGlyphBounds(designPng, glyphs, scale, isExcluded);
		const label = `${element.label} の文字「${element.text.slice(0, 24)}」`;
		for (const edge of compareGlyphs(glyphs, design, scale)) add({ ...edge, kind: "text" }, label);
	}
	const toCssPx = (devicePx) => Math.round((devicePx / scale) * 10) / 10;
	return [...unique.values()].map((edge) => {
		const result =
			edge.kind === "text" ? edge.result : edge.painted ? measureBoxEdge(edge, designPng, actualPng, scale, isExcluded) : null;
		return {
			side: edge.side,
			kind: edge.kind,
			// デザイン画像を design-measure で測り直せるよう、位置は画像の左上が原点の CSS px で出す
			positionCssPx: toCssPx(edge.position),
			rangeCssPx: [toCssPx(edge.from), toCssPx(edge.to)],
			elements: edge.elements,
			status: !result ? "判定不能" : result.delta === null || Math.abs(result.delta) > tolerance ? "ずれ" : "OK",
			delta: result?.delta ?? null,
			reason: result?.reason ?? null,
		};
	});
}

export function formatEdgeReport(results, tolerance) {
	const decided = results.filter((result) => result.status !== "判定不能");
	const mismatched = decided.filter((result) => result.status !== "OK");
	const undecided = results.length - decided.length;
	const lines = [
		mismatched.length === 0
			? `[辺] PASS 判定できた全 ${decided.length} 辺が許容 ±${tolerance}px に収まっている（判定不能 ${undecided} 辺は数えない）`
			: `[辺] FAIL 判定できた ${decided.length} 辺のうち ${mismatched.length} 辺にずれ（許容 ±${tolerance}px、判定不能 ${undecided} 辺は数えない、位置は画像の左上が原点、値は 実装 − デザイン画像）`,
	];
	for (const result of mismatched.slice(0, MAX_CONSOLE_EDGES)) {
		const [axis, along] = result.side === "top" || result.side === "bottom" ? ["y", "x"] : ["x", "y"];
		const deviation = result.delta === null ? result.reason : formatDelta(result.delta);
		lines.push(
			`  ${SIDE_NAMES[result.side]} ${axis}=${result.positionCssPx}（${along}=${result.rangeCssPx[0]}〜${result.rangeCssPx[1]}）  ${deviation}  ← ${result.elements[0]}`,
		);
		if (result.elements.length > 1) lines.push(`    同じ辺: ${result.elements.slice(1).join(", ")}`);
	}
	const rest = mismatched.length - MAX_CONSOLE_EDGES;
	if (rest > 0) lines.push(`  …他 ${rest} 辺（edges.json 参照）`);
	lines.push("デザインにあって実装に無い要素は辺の判定では見つからないので、画素の差分で確かめる");
	return lines.join("\n");
}
