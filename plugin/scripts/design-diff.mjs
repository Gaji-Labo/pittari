import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { collectElementBoxes, compareEdges, formatEdgeReport } from "./modules/edges.mjs";
import { collectDomBoxes, compareLayout, formatLayoutReport, parseMetadata } from "./modules/layout.mjs";
import { createDestinationPolicy, isValidAllowDomain, isValidAllowOrigin, portOf, startBlockingProxy } from "./modules/network.mjs";
import { appendResultsFile, readInputFile, UnsafeResultsPathError, writeResultsFiles } from "./modules/results.mjs";
import { RUN_LOG_FILE, targetLabel, workingTreeHash } from "./design-target.mjs";
import { isLocalDevServerUrl, isLocalHostname } from "./modules/url.mjs";

const { values } = parseArgs({
	options: {
		url: { type: "string" },
		selector: { type: "string" },
		design: { type: "string" },
		width: { type: "string" },
		"design-width": { type: "string" },
		height: { type: "string", default: "1080" },
		threshold: { type: "string", default: "0.02" },
		out: { type: "string" },
		wait: { type: "string", default: "300" },
		hide: { type: "string" },
		exclude: { type: "string", multiple: true },
		metadata: { type: "string", multiple: true },
		texts: { type: "string" },
		"layout-tolerance": { type: "string", default: "1" },
		build: { type: "string" },
		"allow-domain": { type: "string", multiple: true },
		"allow-origin": { type: "string", multiple: true },
	},
});

function fail(message) {
	console.error(message);
	process.exit(1);
}

if (values.build !== undefined) {
	fail("--build は廃止しました。ビルドが必要なプロジェクトでは、design-diff の前にビルドコマンドを単独で実行してください。");
}

const required = ["url", "selector", "design", "width"];
const missing = required.filter((key) => !values[key]);
if (missing.length > 0) {
	fail(`必須引数が不足しています: ${missing.map((k) => `--${k}`).join(", ")}`);
}

for (const [name, min] of [
	["width", 1],
	["design-width", 1],
	["height", 1],
	["threshold", 0],
	["wait", 0],
	["layout-tolerance", 0],
]) {
	if (values[name] === undefined) continue;
	const value = Number(values[name]);
	if (!Number.isFinite(value) || value < min) {
		fail(`--${name} には ${min} 以上の数値を指定してください（渡された値: "${values[name]}"）`);
	}
}

const url = values.url;
// ページを開いたあとのリダイレクト先と、ページが読み込むリソースの宛先は、プロキシサーバーが --url のオリジンと --allow-domain・--allow-origin で絞る。
// そのため、ここでは最初に開く --url だけを確かめる
if (!isLocalDevServerUrl(url)) {
	fail(`--url には、ホスト名が localhost・127.0.0.1・[::1]・*.localhost の http: か https: の URL を指定してください（渡された値: "${url}"）`);
}
const allowDomains = (values["allow-domain"] ?? []).map((domain) => domain.toLowerCase());
const invalidDomain = allowDomains.find((domain) => !isValidAllowDomain(domain));
if (invalidDomain !== undefined) {
	fail(`--allow-domain には、スキーム・ポート・ワイルドカードを付けないホスト名を指定してください（渡された値: "${invalidDomain}"）`);
}
const allowOrigins = values["allow-origin"] ?? [];
const invalidOrigin = allowOrigins.find((origin) => !isValidAllowOrigin(origin));
if (invalidOrigin !== undefined) {
	fail(
		`--allow-origin には、ホスト名が localhost・127.0.0.1・[::1]・*.localhost の、パスと末尾の / を付けないオリジン（例: http://localhost:8080）を指定してください（渡された値: "${invalidOrigin}"）`,
	);
}
const destinationPolicy = createDestinationPolicy(url, allowDomains, allowOrigins);
const selector = values.selector;
const designPath = values.design;
const width = Number(values.width);
// カード 1 枚のようなコンポーネント単位の比較では、ビューポート幅と見本画像に写っている範囲の幅が一致しない
const designWidth = values["design-width"] === undefined ? width : Number(values["design-width"]);
const height = Number(values.height);
const diffRatioThreshold = Number(values.threshold);
const wait = Number(values.wait);
// 見本画像に無い固定ヘッダーのように、撮影時だけ伏せたい要素を呼び出し側が指定する
const hideSelector = values.hide;
// 素材が無くプレースホルダーで実装した要素のように、見本画像と中身が一致しない範囲を比較から外す。
// --hide は実装側だけを隠すので、見本画像側に残る同じ範囲の差分は diffRatio に残る
const excludeSelectors = values.exclude ?? [];
const layoutTolerance = Number(values["layout-tolerance"]);

// スクリプトの置き場所に依存しないよう、入力と出力の置き場所は実行時のカレントディレクトリ（プロジェクトルート）を基準にする
const projectDir = process.cwd();

// Figma の get_metadata の出力を渡されたときだけ、画素差分に加えて要素ごとの箱も比べる
let figmaNodes = null;
let metadataWarnings = [];
if (values.metadata) {
	try {
		({ nodes: figmaNodes, warnings: metadataWarnings } = parseMetadata(values.metadata.map((file) => readInputFile(projectDir, file))));
	} catch (error) {
		fail(`--metadata の XML を読めませんでした\n${error instanceof Error ? error.message : String(error)}`);
	}
}
let nodeTexts = {};
if (values.texts) {
	let textsSource;
	try {
		textsSource = readInputFile(projectDir, values.texts);
	} catch (error) {
		fail(`--texts のファイルを読めませんでした: ${values.texts}\n${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		nodeTexts = JSON.parse(textsSource);
	} catch (error) {
		fail(`--texts のファイルを JSON として読めませんでした: ${values.texts}\n${error instanceof Error ? error.message : String(error)}`);
	}
}

let label;
try {
	label = targetLabel({ selector, width, designWidth: values["design-width"], out: values.out });
} catch (error) {
	fail(error.message);
}

let designPng;
try {
	designPng = PNG.sync.read(readFileSync(designPath));
} catch (error) {
	fail(`--design の画像を PNG として読めませんでした: ${designPath}\n${error instanceof Error ? error.message : String(error)}`);
}
const deviceScaleFactor = designPng.width / designWidth;

const treeHash = workingTreeHash(projectDir);

// 原因の見当がつく撮影の失敗は案内文だけを出し、それ以外の例外はスタックトレースごと表に出す
class CaptureError extends Error {}

// Playwright のエラー文には、起動コマンドの全引数のような長い行と色付けの制御文字が混じり、要点が埋もれる
const MAX_ERROR_LINE_LENGTH = 300;
function errorText(error) {
	const message = error instanceof Error ? error.message : String(error);
	return message
		.replace(/\u001b\[[0-9;]*m/g, "")
		.split("\n")
		.filter((line) => line.length <= MAX_ERROR_LINE_LENGTH)
		.join("\n");
}

const hasIntegerScale = Math.abs(deviceScaleFactor - Math.round(deviceScaleFactor)) <= 1e-6;

// 比較用の画像の左上にあたるページ上の位置。除外範囲を画像の座標へ直すために、cropToPaintedBox と同じ規則で求める
function imageOrigin(rect) {
	const round = hasIntegerScale ? Math.round : Math.floor;
	return { x: round(rect.left), y: round(rect.top) };
}

// 対象の位置や寸法が小数だと、locator.screenshot() の撮影範囲（各辺を CSS px の整数へ外側に丸める）と、
// Chromium が実際に描画する範囲（各辺を CSS px の整数へ最も近く丸める）がずれ、画像の縁に何も描かれていない余白が付く。
// その分だけ寸法と開始位置が見本画像とずれて diffRatio が膨らむので、描画された範囲だけを切り出す
function cropToPaintedBox(png, rect) {
	// 描画範囲の規則は dsf が 1 と 2 のときだけ実測で確かめた。1.5 では対象の端が削れたので、整数でなければ切り出さない
	if (!hasIntegerScale) return png;
	const toDevicePx = (cssPx) => Math.round(cssPx * deviceScaleFactor);
	const paintedLeft = Math.round(rect.left);
	const paintedTop = Math.round(rect.top);
	const x = toDevicePx(paintedLeft - Math.floor(rect.left));
	const y = toDevicePx(paintedTop - Math.floor(rect.top));
	const cropWidth = toDevicePx(Math.round(rect.right) - paintedLeft);
	const cropHeight = toDevicePx(Math.round(rect.bottom) - paintedTop);
	// 変形などで対象の箱と撮影範囲が対応しない場合は、切り出さずに撮影結果をそのまま使う
	if (cropWidth <= 0 || cropHeight <= 0 || x + cropWidth > png.width || y + cropHeight > png.height) return png;
	const cropped = new PNG({ width: cropWidth, height: cropHeight });
	PNG.bitblt(png, cropped, x, y, cropWidth, cropHeight, 0, 0);
	return cropped;
}

const blockedRequests = [];

function isBlockedUrl(value) {
	let parsed;
	try {
		parsed = new URL(value);
	} catch {
		return false;
	}
	return ["http:", "https:"].includes(parsed.protocol) && !destinationPolicy.isAllowed(parsed.hostname, portOf(parsed));
}

async function captureActual(proxy) {
	let browser;
	try {
		// playwright が版を固定して配る Chromium ではなく自動更新される Chrome を使い、ブラウザの脆弱性の修正をプラグインの更新から切り離す
		// Playwright は既定で Chrome のサンドボックスを外して起動するので、chromiumSandbox を明示して有効にする
		browser = await chromium.launch({
			channel: "chrome",
			chromiumSandbox: true,
			proxy: { server: proxy.server, bypass: destinationPolicy.proxyBypass },
			// WebRTC の UDP の通信はプロキシサーバーを通らないので、Chrome の起動引数で止める
			args: ["--webrtc-ip-handling-policy=disable_non_proxied_udp"],
		});
	} catch (error) {
		throw new CaptureError(
			`Chrome を起動できません。Google Chrome がインストールされているか、サンドボックス内で実行していないか確認してください。\n${errorText(error)}`,
		);
	}
	try {
		// 撮影ごとに新しいコンテキストで開くとオープニングなどの演出が毎回再生されるので、完成形を撮らせる
		const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor, reducedMotion: "reduce" });
		context.on("requestfailed", (request) => {
			if (isBlockedUrl(request.url())) blockedRequests.push({ url: request.url(), resourceType: request.resourceType() });
		});
		const page = await context.newPage();
		const throwIfLeftDevServer = () => {
			if (new URL(page.url()).origin === destinationPolicy.devOrigin) return;
			throw new CaptureError(
				`ページが開発サーバーの外へ移ったので、撮影せずに終えました（移った先: ${page.url()}。遮断した外部のホストへ移ったときは Chrome のエラー画面の URL になる）\n開発サーバーのリダイレクトや、location を書き換えるスクリプトを確かめてください。`,
			);
		};
		try {
			await page.goto(url, { waitUntil: "networkidle" });
		} catch (error) {
			throw new CaptureError(
				`ページの読み込みに失敗しました: ${url}\n開発サーバーが起動しているか、--url の値が正しいか、開発サーバーが外部へリダイレクトしていないか確認してください。\n${errorText(error)}`,
			);
		}
		// ヘッドレスの Chromium はスクロールバーを幅 0 で隠すが、scrollbar-gutter: stable はその幅を確保し続けるので、
		// 見本画像には無い空白の帯が右端に写る
		await page.addStyleTag({ content: ":root { scrollbar-gutter: auto !important; }" });

		const locator = page.locator(selector);
		try {
			await locator.waitFor({ state: "visible", timeout: 10_000 });
		} catch (error) {
			throwIfLeftDevServer();
			if (error instanceof Error && error.name === "TimeoutError") {
				throw new CaptureError(
					`要素が見つかりませんでした: ${selector}\nセレクタが正しいか、変更が描画先に反映されている（ビルドが必要なプロジェクトならビルド済み）か確認してください。`,
				);
			}
			throw new CaptureError(`セレクタの解決に失敗しました: ${selector}\n${errorText(error)}`);
		}
		if (hideSelector) {
			// 渡されたセレクタが通常フローの要素を指した場合に対象の位置がずれないよう、領域を残して隠す
			await page.addStyleTag({ content: `${hideSelector} { visibility: hidden !important; }` });
		}
		// 対象が画面外にあると、負の z-index に置いた背景が合成されないまま撮れる。
		// locator.screenshot() も撮影の直前にスクロールするが、そこから描画までの猶予が無い
		await locator.scrollIntoViewIfNeeded();
		await page.waitForTimeout(wait);
		// boundingBox() はビューポート基準でスクロール量に左右されるので、撮影範囲と同じページ基準で測る
		const rect = await locator.evaluate((el) => {
			const r = el.getBoundingClientRect();
			return {
				left: r.left + window.scrollX,
				top: r.top + window.scrollY,
				right: r.right + window.scrollX,
				bottom: r.bottom + window.scrollY,
			};
		});
		const excludeBoxes = [];
		for (const excludeSelector of excludeSelectors) {
			const boxes = await page.locator(excludeSelector).evaluateAll((els) =>
				els
					.map((el) => {
						const r = el.getBoundingClientRect();
						return { left: r.left + window.scrollX, top: r.top + window.scrollY, right: r.right + window.scrollX, bottom: r.bottom + window.scrollY };
					})
					.filter((r) => r.right > r.left && r.bottom > r.top),
			);
			// セレクタの打ち間違いで何も外れないまま、除外したつもりで合否を出さないようにする
			if (boxes.length === 0) {
				throw new CaptureError(`--exclude の要素が見つからないか、描画された範囲を持ちません: ${excludeSelector}`);
			}
			excludeBoxes.push({ selector: excludeSelector, boxes });
		}
		const domBoxes = figmaNodes ? await locator.evaluate(collectDomBoxes) : null;
		// Figma のノードが無い実行では、突き合わせる箱がデザイン側に無いので、実装側の要素の辺をデザイン画像の中で探す
		const elementBoxes = figmaNodes ? null : await locator.evaluate(collectElementBoxes);
		const buffer = await locator.screenshot();
		throwIfLeftDevServer();
		return { buffer, rect, domBoxes, elementBoxes, excludeBoxes };
	} finally {
		await browser.close();
	}
}

let actualBuffer;
let targetRect;
let domBoxes;
let elementBoxes;
let excludeBoxes;
const proxy = await startBlockingProxy(destinationPolicy);
try {
	({ buffer: actualBuffer, rect: targetRect, domBoxes, elementBoxes, excludeBoxes } = await captureActual(proxy));
} catch (error) {
	if (error instanceof CaptureError) fail(error.message);
	throw error;
} finally {
	await proxy.close();
}

// ローカルの宛先はホスト名だけでは開発サーバーと見分けられず、許可にも --allow-origin のオリジンが要るので、外部のホストと分けてオリジンで出す
const blockedHosts = new Map();
const blockedLocalOrigins = new Map();
for (const { url: blockedUrl, resourceType } of blockedRequests) {
	const parsed = new URL(blockedUrl);
	const [groups, key] = isLocalHostname(parsed.hostname)
		? [blockedLocalOrigins, parsed.origin]
		: [blockedHosts, parsed.hostname];
	const types = groups.get(key) ?? {};
	types[resourceType] = (types[resourceType] ?? 0) + 1;
	groups.set(key, types);
}

const screenshotPng = PNG.sync.read(actualBuffer);
const actualPng = cropToPaintedBox(screenshotPng, targetRect);

const canvasWidth = Math.max(designPng.width, actualPng.width);
const canvasHeight = Math.max(designPng.height, actualPng.height);

function fillPng(png, [r, g, b]) {
	for (let i = 0; i < png.data.length; i += 4) {
		png.data[i] = r;
		png.data[i + 1] = g;
		png.data[i + 2] = b;
		png.data[i + 3] = 255;
	}
}

function padToCanvas(png) {
	const canvas = new PNG({ width: canvasWidth, height: canvasHeight });
	fillPng(canvas, [255, 0, 255]);
	PNG.bitblt(png, canvas, 0, 0, png.width, png.height, 0, 0);
	return canvas;
}

const designCanvas = padToCanvas(designPng);
const actualCanvas = padToCanvas(actualPng);

// ---- 比較から外す範囲 ----

const EXCLUDED_COLOR = [0, 160, 255];
const origin = imageOrigin(targetRect);
const excludedMask = new Uint8Array(canvasWidth * canvasHeight);
const deviceToCssPx = (devicePx) => Math.round((devicePx / deviceScaleFactor) * 100) / 100;
const excludedReports = excludeBoxes.map(({ selector: excludeSelector, boxes }) => ({
	selector: excludeSelector,
	rectsCssPx: boxes.map((box) => {
		const left = Math.max(0, Math.floor((box.left - origin.x) * deviceScaleFactor));
		const top = Math.max(0, Math.floor((box.top - origin.y) * deviceScaleFactor));
		const right = Math.min(canvasWidth, Math.ceil((box.right - origin.x) * deviceScaleFactor));
		const bottom = Math.min(canvasHeight, Math.ceil((box.bottom - origin.y) * deviceScaleFactor));
		for (let y = top; y < bottom; y++) excludedMask.fill(1, y * canvasWidth + left, y * canvasWidth + Math.max(left, right));
		return { x: deviceToCssPx(left), y: deviceToCssPx(top), width: deviceToCssPx(Math.max(0, right - left)), height: deviceToCssPx(Math.max(0, bottom - top)) };
	}),
}));
const excludedPixels = excludedMask.reduce((sum, flag) => sum + flag, 0);

// 両方の画像の同じ範囲を同じ色で塗ると、pixelmatch は差分なしと判定し、外した範囲が design.png と actual.png でも分かる
function paintExcluded(png) {
	for (let i = 0; i < excludedMask.length; i++) {
		if (!excludedMask[i]) continue;
		png.data[i * 4] = EXCLUDED_COLOR[0];
		png.data[i * 4 + 1] = EXCLUDED_COLOR[1];
		png.data[i * 4 + 2] = EXCLUDED_COLOR[2];
		png.data[i * 4 + 3] = 255;
	}
}
paintExcluded(designCanvas);
paintExcluded(actualCanvas);

// pixelmatch の diffColor 既定値 [255, 0, 0] のピクセルのみを差分として扱う（aaColor の黄色は除外）
function isDiffPixel(data, i) {
	return data[i] === 255 && data[i + 1] === 0 && data[i + 2] === 0;
}

// pixelmatch 自体のピクセル単位の色差判定用しきい値（0-1）。--threshold（diffRatio 全体の合否判定）とは無関係。
const PIXELMATCH_COLOR_THRESHOLD = 0.1;

const diffPng = new PNG({ width: canvasWidth, height: canvasHeight });
const diffPixels = pixelmatch(designCanvas.data, actualCanvas.data, diffPng.data, canvasWidth, canvasHeight, {
	threshold: PIXELMATCH_COLOR_THRESHOLD,
});

// pixelmatch は差分のない画素を薄いグレーに描くので、外した範囲は塗り直して差分なしの画素と区別する
paintExcluded(diffPng);

const totalPixels = canvasWidth * canvasHeight - excludedPixels;
const diffRatio = diffPixels / totalPixels;
const pixelPass = diffRatio <= diffRatioThreshold;

// ---- 要素ごとの箱の比較 ----

const layoutResults = figmaNodes ? compareLayout(figmaNodes, domBoxes, nodeTexts, layoutTolerance) : null;
const layoutPass = layoutResults === null || layoutResults.every((result) => result.status === "OK");

// ---- 要素の辺の比較（デザイン画像の入力） ----

// 要素の箱は対象の左上が原点なので、比較用の画像の左上（origin）との差だけずらして画像の座標に直す
const edgeResults = figmaNodes
	? null
	: compareEdges(designPng, actualPng, elementBoxes, {
			scale: deviceScaleFactor,
			offset: { x: targetRect.left - origin.x, y: targetRect.top - origin.y },
			tolerance: layoutTolerance,
			isExcluded: (x, y) => excludedMask[y * canvasWidth + x] === 1,
		});
const edgeDecided = edgeResults?.filter((result) => result.status !== "判定不能") ?? [];
const edgePass = edgeDecided.every((result) => result.status === "OK");
const pass = pixelPass && layoutPass && edgePass;

// ---- 差分クラスタ ----
// AI が画像を読まずに修正箇所のあたりを付けるための概算レポート。座標はセル（16px）精度で十分とする。

const CLUSTER_CELL = 16;
const MIN_CLUSTER_PIXELS = 8 * deviceScaleFactor ** 2; // 差分 8 CSS px² 相当未満はノイズとして除外
const MAX_CONSOLE_CLUSTERS = 5;

function findDiffClusters(diffData) {
	const cols = Math.ceil(canvasWidth / CLUSTER_CELL);
	const cellCounts = new Map(); // セル index → セル内の差分ピクセル数
	for (let y = 0; y < canvasHeight; y++) {
		for (let x = 0; x < canvasWidth; x++) {
			if (!isDiffPixel(diffData, (y * canvasWidth + x) * 4)) continue;
			const idx = Math.floor(y / CLUSTER_CELL) * cols + Math.floor(x / CLUSTER_CELL);
			cellCounts.set(idx, (cellCounts.get(idx) ?? 0) + 1);
		}
	}

	const clusters = [];
	// Map の live イテレータは削除済みキーを飛ばすので、走査中の delete と併用できる
	for (const start of cellCounts.keys()) {
		const box = { count: 0, minX: Infinity, maxX: -1, minY: Infinity, maxY: -1 };
		const stack = [start];
		while (stack.length > 0) {
			const idx = stack.pop();
			if (!cellCounts.has(idx)) continue;
			box.count += cellCounts.get(idx);
			cellCounts.delete(idx);
			const cx = idx % cols;
			const cy = Math.floor(idx / cols);
			box.minX = Math.min(box.minX, cx);
			box.maxX = Math.max(box.maxX, cx);
			box.minY = Math.min(box.minY, cy);
			box.maxY = Math.max(box.maxY, cy);
			// 8 近傍のセルを連結する。範囲外や差分の無いセルは Map に無いので自然に無視される
			for (let dy = -1; dy <= 1; dy++) {
				for (let dx = -1; dx <= 1; dx++) {
					if (cx + dx >= 0 && cx + dx < cols) stack.push(idx + dy * cols + dx);
				}
			}
		}
		clusters.push(box);
	}
	return clusters.sort((a, b) => b.count - a.count);
}

const clusters = findDiffClusters(diffPng.data).filter((c) => c.count >= MIN_CLUSTER_PIXELS);

// クラスタ座標は見本画像に写っている範囲の幅を基準にした CSS px に換算して報告する
const toCssPx = (cells) => Math.round((cells * CLUSTER_CELL) / deviceScaleFactor);
const clusterReports = clusters.map((c) => ({
	x: toCssPx(c.minX),
	y: toCssPx(c.minY),
	width: toCssPx(c.maxX - c.minX + 1),
	height: toCssPx(c.maxY - c.minY + 1),
	diffPixels: c.count,
}));

// ---- compare.png（design | actual | diff を縮小して横並びにした閲覧用の 1 枚） ----

const COMPARE_PANE_WIDTH = 400;
const COMPARE_MAX_HEIGHT = 1000; // 縦長セクションで compare.png が読めない縦横比にならないよう高さも縛る

function downscale(png, scale) {
	if (scale >= 1) return png;
	const outWidth = Math.max(1, Math.round(png.width * scale));
	const outHeight = Math.max(1, Math.round(png.height * scale));
	const out = new PNG({ width: outWidth, height: outHeight });
	for (let y = 0; y < outHeight; y++) {
		for (let x = 0; x < outWidth; x++) {
			const sx = Math.min(png.width - 1, Math.floor(x / scale));
			const sy = Math.min(png.height - 1, Math.floor(y / scale));
			out.data.set(png.data.subarray((sy * png.width + sx) * 4, (sy * png.width + sx) * 4 + 4), (y * outWidth + x) * 4);
		}
	}
	return out;
}

// 縮小サンプリングで細い差分線が消えないよう、差分ピクセルは縮小後の該当位置を純赤で塗り直す
function markDiffRed(source, scaled, scale) {
	for (let y = 0; y < source.height; y++) {
		for (let x = 0; x < source.width; x++) {
			if (!isDiffPixel(source.data, (y * source.width + x) * 4)) continue;
			const ox = Math.min(scaled.width - 1, Math.floor(x * scale));
			const oy = Math.min(scaled.height - 1, Math.floor(y * scale));
			const o = (oy * scaled.width + ox) * 4;
			scaled.data[o] = 255;
			scaled.data[o + 1] = 0;
			scaled.data[o + 2] = 0;
		}
	}
}

function compositeRow(pngs, separator = 4) {
	const outWidth = pngs.reduce((sum, p) => sum + p.width, 0) + separator * (pngs.length - 1);
	const outHeight = Math.max(...pngs.map((p) => p.height));
	const out = new PNG({ width: outWidth, height: outHeight });
	fillPng(out, [128, 128, 128]);
	let offsetX = 0;
	for (const p of pngs) {
		PNG.bitblt(p, out, 0, 0, p.width, p.height, offsetX, 0);
		offsetX += p.width + separator;
	}
	return out;
}

const compareScale = Math.min(1, COMPARE_PANE_WIDTH / canvasWidth, COMPARE_MAX_HEIGHT / canvasHeight);
const diffPane = downscale(diffPng, compareScale);
if (compareScale < 1) markDiffRed(diffPng, diffPane, compareScale);
const comparePng = compositeRow([downscale(designCanvas, compareScale), downscale(actualCanvas, compareScale), diffPane]);

const summary = {
	pass,
	pixelPass,
	layout: layoutResults && {
		pass: layoutPass,
		tolerance: layoutTolerance,
		mismatched: layoutResults.filter((result) => result.status !== "OK").length,
		total: layoutResults.length,
	},
	edges: edgeResults && {
		pass: edgePass,
		tolerance: layoutTolerance,
		mismatched: edgeDecided.filter((result) => result.status !== "OK").length,
		decided: edgeDecided.length,
		undecided: edgeResults.length - edgeDecided.length,
	},
	diffRatio,
	diffPixels,
	totalPixels,
	excludedPixels,
	excludedCssPx: excludedReports,
	diffClustersCssPx: clusterReports,
	designSize: { width: designPng.width, height: designPng.height },
	actualSize: { width: actualPng.width, height: actualPng.height },
	screenshotSize: { width: screenshotPng.width, height: screenshotPng.height },
	targetRectCssPx: targetRect,
	deviceScaleFactor,
	diffRatioThreshold,
	args: { url, selector, designPath, width, designWidth, height, wait, exclude: excludeSelectors, allowDomains, allowOrigins },
	timestamp: new Date().toISOString(),
};
const outputFiles = {
	"design.png": PNG.sync.write(designCanvas),
	"actual.png": PNG.sync.write(actualCanvas),
	"diff.png": PNG.sync.write(diffPng),
	"compare.png": PNG.sync.write(comparePng),
	"summary.json": JSON.stringify(summary, null, 2),
};
if (layoutResults) {
	outputFiles["layout.json"] = JSON.stringify({ tolerance: layoutTolerance, warnings: metadataWarnings, results: layoutResults }, null, 2);
}
if (edgeResults) outputFiles["edges.json"] = JSON.stringify({ tolerance: layoutTolerance, results: edgeResults }, null, 2);
try {
	writeResultsFiles(projectDir, [label], outputFiles);
	// summary.json は毎回上書きされるので、Stop hook が試行回数と計測後の変更の有無を確かめられるよう、実行ごとに 1 行残す。
	// 箱や辺だけで不合格になると diffRatio は閾値内に収まっているので、どの判定で落ちたかを Stop hook の理由に出せるよう件数も残す
	appendResultsFile(
		projectDir,
		[label],
		RUN_LOG_FILE,
		`${JSON.stringify({
			at: summary.timestamp,
			pass,
			pixelPass,
			diffRatio,
			layoutMismatched: summary.layout?.mismatched ?? null,
			edgeMismatched: summary.edges?.mismatched ?? null,
			treeHash,
		})}\n`,
	);
} catch (error) {
	if (!(error instanceof UnsafeResultsPathError)) throw error;
	fail(`.design-diff の中を読み書きせずに終えました: ${error.message}`);
}

if (layoutResults) {
	for (const warning of metadataWarnings) console.log(`警告: ${warning}`);
	console.log(formatLayoutReport(layoutResults, layoutTolerance));
}
if (edgeResults) {
	console.log(formatEdgeReport(edgeResults, layoutTolerance));
}

console.log(
	`[画素] ${pixelPass ? "PASS" : "FAIL"} diffRatio=${(diffRatio * 100).toFixed(2)}% (threshold=${(diffRatioThreshold * 100).toFixed(2)}%)`,
);
if (excludedPixels > 0) {
	const excludedCount = excludedReports.reduce((sum, report) => sum + report.rectsCssPx.length, 0);
	console.log(`比較から外した範囲: ${excludedCount} 件（${excludedPixels} 画素、diffRatio の分母から除く。diff.png では青で塗る）`);
}
function printBlocked(heading, groups) {
	if (groups.size === 0) return;
	console.log(heading);
	for (const [destination, resourceTypes] of groups) {
		console.log(`  ${destination}: ${Object.entries(resourceTypes).map(([type, count]) => `${type} ${count} 件`).join(", ")}`);
	}
}
printBlocked("読み込めなかった外部のホスト（--allow-domain で許可していないので遮断した。リソースの種類と件数）:", blockedHosts);
printBlocked("読み込めなかったローカルの宛先（--url と別のオリジンで、--allow-origin で許可していないので遮断した。リソースの種類と件数）:", blockedLocalOrigins);
if (!pixelPass) {
	if (clusterReports.length > 0) {
		console.log("差分クラスタ（CSS px 概算、差分量の大きい順）:");
		clusterReports.slice(0, MAX_CONSOLE_CLUSTERS).forEach((c, i) => {
			console.log(`  ${i + 1}. x=${c.x} y=${c.y} w=${c.width} h=${c.height} 差分量=${c.diffPixels}`);
		});
		const rest = clusterReports.length - MAX_CONSOLE_CLUSTERS;
		if (rest > 0) console.log(`  …他 ${rest} 件（summary.json 参照）`);
	} else {
		console.log("差分クラスタなし（ノイズ級の微小差分が散在）。compare.png で全体を確認する");
	}
	console.log(
		`画像確認はまず compare.png（design | actual | diff の縮小横並び）、詰めの確認のみ原寸 3 枚を読む（原寸画像上の座標はクラスタ座標の ${deviceScaleFactor} 倍）`,
	);
}
console.log(`出力先: ${join(projectDir, ".design-diff", label)}`);

process.exit(pass ? 0 : 1);
