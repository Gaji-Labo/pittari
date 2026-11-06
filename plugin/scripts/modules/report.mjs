// 箱の比較（[箱]）と辺の比較（[辺]）の報告で、ずれの値を同じ書き方で出すために、両方から使う

export const formatDelta = (value) => (Math.abs(value) < 0.05 ? "0" : `${value > 0 ? "+" : ""}${value.toFixed(1)}`);
