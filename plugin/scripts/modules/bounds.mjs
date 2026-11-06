// 画像の範囲の中で、背景と色の違う画素の外接矩形を取る。
// 背景の決め方と色の差の測り方は呼び出し側で違うので、画素ごとの背景との差を返す関数 distanceAt で受け取る。
// distanceAt が null を返した画素は、背景の差の最大にも外接矩形にも入れない

// 範囲は left・top を含み、right・bottom を含まない画素座標。返す外接矩形も同じ
export function boundsWhere(region, include) {
	const bounds = { left: Infinity, top: Infinity, right: -1, bottom: -1 };
	for (let y = region.top; y < region.bottom; y++) {
		for (let x = region.left; x < region.right; x++) {
			if (!include(x, y)) continue;
			bounds.left = Math.min(bounds.left, x);
			bounds.top = Math.min(bounds.top, y);
			bounds.right = Math.max(bounds.right, x + 1);
			bounds.bottom = Math.max(bounds.bottom, y + 1);
		}
	}
	return bounds.right === -1 ? null : bounds;
}

// アンチエイリアスの薄い縁まで含めると寸法が 1px ほど膨らむので、背景との差が最大の半分以上ある画素だけで外接矩形を取る。
// max は背景との差の最大、maxAt はそれを最初に取った画素。中身が無いかは max を見て呼び出し側が決める
export function contentBounds(region, distanceAt) {
	let max = 0;
	let maxAt = null;
	for (let y = region.top; y < region.bottom; y++) {
		for (let x = region.left; x < region.right; x++) {
			const distance = distanceAt(x, y);
			if (distance === null || distance <= max) continue;
			max = distance;
			maxAt = { x, y };
		}
	}
	const bounds = boundsWhere(region, (x, y) => {
		const distance = distanceAt(x, y);
		return distance !== null && distance >= max / 2;
	});
	return { max, maxAt, bounds };
}
