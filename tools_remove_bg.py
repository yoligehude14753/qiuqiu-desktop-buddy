#!/usr/bin/env python3
"""把角色图的白底抠成透明 —— 只删与边缘连通的近白区域,保留内部白色(短裤/护袜),
并去掉抗锯齿留下的白边(背景遮罩向角色内膨胀 + 去白溢色 + 羽化)。"""
import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage

THRESH = 228       # 三通道都 > 此值视为近白(略降以吃掉浅灰白边)
GROW = 2           # 背景遮罩向角色内膨胀像素(吃掉白边光晕)
DESPILL = 246      # 边缘附近接近纯白的像素直接判为背景


def remove_bg(path_in, path_out):
    im = Image.open(path_in).convert("RGB")
    arr = np.asarray(im).astype(np.int16)
    near_white = np.all(arr > THRESH, axis=2)

    # 连通域:只保留与四边相连的白(=背景),内部白(短裤/护袜)保住
    labeled, _ = ndimage.label(near_white)
    border = set(labeled[0, :]) | set(labeled[-1, :]) | set(labeled[:, 0]) | set(labeled[:, -1])
    border.discard(0)
    bg = np.isin(labeled, list(border))

    # 背景遮罩向内膨胀,吃掉抗锯齿白边光晕
    bg = ndimage.binary_dilation(bg, iterations=GROW)

    # 去溢色:与背景相邻、且非常接近纯白的像素也归背景(消残留白边)
    edge_band = ndimage.binary_dilation(bg, iterations=2) & ~bg
    very_white = np.all(arr > DESPILL, axis=2)
    bg = bg | (edge_band & very_white)

    alpha = np.where(bg, 0, 255).astype(np.uint8)
    rgba = np.dstack([arr.astype(np.uint8), alpha])
    out = Image.fromarray(rgba, "RGBA")

    # 轻羽化,边缘更柔和不发白
    a = out.split()[3].filter(ImageFilter.GaussianBlur(0.6))
    out.putalpha(a)
    out.save(path_out)
    print(f"{path_in} -> 主体占比 {100*(1-bg.mean()):.1f}%")


if __name__ == "__main__":
    import os
    base = os.path.join(os.path.dirname(__file__), "renderer", "models")
    for f in ["fan_calm.png", "fan_hype.png", "fan_angry.png"]:
        p = os.path.join(base, f)
        remove_bg(p, p)  # 原地覆盖为透明版
