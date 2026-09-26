//! Geometry for the `window` action on Windows, kept free of Win32 calls so it can be tested.
//!
//! Coordinates are physical pixels (the daemon is per-monitor DPI aware v2), top-left origin,
//! as in GetWindowRect / MONITORINFO.rcWork.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl Rect {
    pub fn new(left: i32, top: i32, right: i32, bottom: i32) -> Self {
        Rect { left, top, right, bottom }
    }
    pub fn width(&self) -> i32 {
        self.right - self.left
    }
    pub fn height(&self) -> i32 {
        self.bottom - self.top
    }
    pub fn center(&self) -> (i32, i32) {
        ((self.left + self.right) / 2, (self.top + self.bottom) / 2)
    }
    pub fn from_xywh(x: i32, y: i32, w: i32, h: i32) -> Self {
        Rect::new(x, y, x + w, y + h)
    }
}

pub const WINDOW_OPS: [&str; 9] = ["left", "right", "top", "bottom", "maximize", "center", "next-display", "minimize", "fullscreen"];

/// Where the window's visible frame should go for a move/resize op. `window` is the current visible
/// frame, `current` the work area of its monitor, `next` the work area of the next monitor
/// (for next-display). Returns None for ops that are not a plain rectangle (minimize, maximize,
/// fullscreen are ShowWindow calls).
pub fn snap(op: &str, window: Rect, current: Rect, next: Rect) -> Option<Rect> {
    let w = current;
    let half_w = w.width() / 2;
    let half_h = w.height() / 2;
    Some(match op {
        "left" => Rect::from_xywh(w.left, w.top, half_w, w.height()),
        "right" => Rect::new(w.left + half_w, w.top, w.right, w.bottom),
        "top" => Rect::from_xywh(w.left, w.top, w.width(), half_h),
        "bottom" => Rect::new(w.left, w.top + half_h, w.right, w.bottom),
        "center" => {
            let cw = window.width().min(w.width());
            let ch = window.height().min(w.height());
            let (cx, cy) = w.center();
            Rect::from_xywh(cx - cw / 2, cy - ch / 2, cw, ch)
        }
        "next-display" => {
            // Keep the window's relative position and its size (clamped) on the new monitor.
            let rx = (window.left - current.left) as f64 / current.width().max(1) as f64;
            let ry = (window.top - current.top) as f64 / current.height().max(1) as f64;
            let nw = window.width().min(next.width());
            let nh = window.height().min(next.height());
            let x = (next.left + (rx * next.width() as f64).round() as i32).clamp(next.left, next.right - nw);
            let y = (next.top + (ry * next.height() as f64).round() as i32).clamp(next.top, next.bottom - nh);
            Rect::from_xywh(x, y, nw, nh)
        }
        _ => return None,
    })
}

/// Windows 10/11 windows have invisible resize borders: GetWindowRect is larger than what you see
/// (DWMWA_EXTENDED_FRAME_BOUNDS). To make the visible frame land on `target`, grow `target` by
/// those borders before SetWindowPos.
pub fn compensate_invisible_border(target: Rect, window_rect: Rect, visible: Rect) -> Rect {
    Rect::new(
        target.left - (visible.left - window_rect.left),
        target.top - (visible.top - window_rect.top),
        target.right + (window_rect.right - visible.right),
        target.bottom + (window_rect.bottom - visible.bottom),
    )
}

/// Index of the monitor after the one containing `point`, in the order given.
pub fn next_monitor(monitors: &[Rect], point: (i32, i32)) -> Option<usize> {
    if monitors.len() < 2 {
        return None;
    }
    let i = monitors
        .iter()
        .position(|m| point.0 >= m.left && point.0 < m.right && point.1 >= m.top && point.1 < m.bottom)
        .unwrap_or(0);
    Some((i + 1) % monitors.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORK: Rect = Rect { left: 0, top: 0, right: 1920, bottom: 1040 };

    #[test]
    fn halves() {
        let win = Rect::from_xywh(100, 100, 800, 600);
        assert_eq!(snap("left", win, WORK, WORK), Some(Rect::new(0, 0, 960, 1040)));
        assert_eq!(snap("right", win, WORK, WORK), Some(Rect::new(960, 0, 1920, 1040)));
        assert_eq!(snap("top", win, WORK, WORK), Some(Rect::new(0, 0, 1920, 520)));
        assert_eq!(snap("bottom", win, WORK, WORK), Some(Rect::new(0, 520, 1920, 1040)));
        assert_eq!(snap("minimize", win, WORK, WORK), None);
    }

    #[test]
    fn center_keeps_size_and_clamps() {
        let win = Rect::from_xywh(0, 0, 800, 600);
        assert_eq!(snap("center", win, WORK, WORK), Some(Rect::from_xywh(560, 220, 800, 600)));
        let huge = Rect::from_xywh(0, 0, 4000, 3000);
        assert_eq!(snap("center", huge, WORK, WORK), Some(WORK));
    }

    #[test]
    fn next_display_keeps_relative_position() {
        let second = Rect::new(1920, 0, 1920 + 2560, 1400);
        let win = Rect::from_xywh(960, 520, 800, 400);
        let r = snap("next-display", win, WORK, second).unwrap();
        assert_eq!((r.width(), r.height()), (800, 400));
        assert_eq!(r.left, 1920 + 1280);
        assert_eq!(r.top, 700);
        assert_eq!(next_monitor(&[WORK, second], (100, 100)), Some(1));
        assert_eq!(next_monitor(&[WORK, second], (2000, 100)), Some(0));
        assert_eq!(next_monitor(&[WORK], (100, 100)), None);
    }

    #[test]
    fn invisible_borders_are_added_back() {
        // Typical Windows 11: 7 px invisible border left/right/bottom, none on top.
        let window_rect = Rect::new(93, 100, 907, 707);
        let visible = Rect::new(100, 100, 900, 700);
        let target = Rect::new(0, 0, 960, 1040);
        assert_eq!(compensate_invisible_border(target, window_rect, visible), Rect::new(-7, 0, 967, 1047));
    }
}
