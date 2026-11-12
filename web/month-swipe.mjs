// 月历内容区跟手切月：与周课表共用方向锁、距离与速度语义，
// 但一次手势只吸附相邻月，避免微小位移跨越多月。
export const MONTH_SWIPE = Object.freeze({
  lock: 8,
  ratio: 1.2,
  distance: 0.18,
  velocity: 0.35,
  clickSuppressMs: 400,
  duration: 220,
});

export function monthSwipeVelocity(samples) {
  if (!Array.isArray(samples) || samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  const cutoff = last.t - 100;
  const first = samples.find((sample) => sample.t >= cutoff) ?? samples[0];
  const span = last.t - first.t;
  return span >= 8 ? (last.x - first.x) / span : 0;
}

// 负数位移（左拖）返回 +1：后一月；正数返回 -1：前一月；不足阈值返回 0。
// 速度方向与位移一致才按快甩处理，反向快速收手仍按可见位移回弹。
export function monthSwipeDelta(deltaX, width, velocity = 0) {
  const viewport = Math.max(1, Number(width) || 1);
  const dx = Number(deltaX) || 0;
  if (!dx) return 0;
  const moved = Math.abs(dx) / viewport;
  const direction = dx < 0 ? 1 : -1;
  const speed = Number(velocity) || 0;
  const flick = Math.abs(speed) >= MONTH_SWIPE.velocity && Math.sign(speed) === Math.sign(dx);
  if (flick) return direction;
  return moved >= MONTH_SWIPE.distance ? direction : 0;
}

function prefersReduced() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// 三页轨道：前月、当前、后月。邻页由调用方渲染，本模块只负责位移、吸附与点击抑制。
export function bindMonthSwipe({
  viewport,
  track,
  canStart = () => true,
  onStart = () => {},
  onTarget = () => {},
  onCommit,
  onSettled = () => {},
  onCancel = () => {},
}) {
  if (!viewport || !track) return { reset() {}, destroy() {}, isDragging: () => false };

  let gesture = null;
  let locked = false;
  let lockedDelta = 0;
  let suppressClickUntil = 0;
  let destroyed = false;
  let width = 0;

  const transformOf = (x) => `translate3d(${x}px, 0, 0)`;

  function jumpTo(x) {
    track.style.transition = 'none';
    track.style.transform = transformOf(x);
    void track.offsetWidth;
  }

  function center() {
    width = viewport.clientWidth || 0;
    jumpTo(-width);
  }

  function animateTo(x, duration) {
    return new Promise((resolve) => {
      if (duration <= 0) {
        jumpTo(x);
        resolve();
        return;
      }
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        track.removeEventListener('transitionend', onEnd);
        resolve();
      };
      const onEnd = (event) => {
        if (event.target === track && event.propertyName === 'transform') finish();
      };
      const timer = setTimeout(finish, duration + 80);
      track.style.transition = `transform ${duration}ms cubic-bezier(0.22, 0.61, 0.36, 1)`;
      void track.offsetWidth;
      track.style.transform = transformOf(x);
      track.addEventListener('transitionend', onEnd);
    });
  }

  function follow(dx) {
    const base = -gesture.width;
    let x = base + dx;
    if (dx > gesture.width) x = (dx - gesture.width) * 0.3;
    else if (dx < -gesture.width) {
      const extra = dx + gesture.width;
      x = -gesture.width * 2 + extra * 0.3;
    }
    track.style.transition = 'none';
    track.style.transform = transformOf(x);
  }

  function reset() {
    gesture = null;
    center();
  }

  async function finish(cancel) {
    const active = gesture;
    gesture = null;
    if (!active || active.axis !== 'x') {
      if (active) center();
      return;
    }
    suppressClickUntil = performance.now() + MONTH_SWIPE.clickSuppressMs;
    if (locked) return;
    const velocity = cancel ? 0 : monthSwipeVelocity(active.samples);
    const delta = cancel ? 0 : monthSwipeDelta(active.deltaX, active.width, velocity);
    if (!delta) {
      await animateTo(-active.width, MONTH_SWIPE.duration);
      onCancel();
      return;
    }
    locked = true;
    lockedDelta = delta;
    // 目标月确定后立即读取，与吸附动画并行；动画只负责位移，不等待网络。
    try { onTarget?.(delta, active.width); } catch { /* 目标预读失败不影响手势 */ }
    // 轨道页序为 [前月, 当前, 后月]：下一月要移到 -2 页，上一月移到 0。
    const targetX = -active.width - delta * active.width;
    await animateTo(targetX, prefersReduced() ? 0 : MONTH_SWIPE.duration);
    let ok = false;
    try {
      ok = await onCommit?.(delta, active.width);
    } catch {
      ok = false;
    }
    width = viewport.clientWidth || active.width;
    if (!ok) {
      await animateTo(-width, prefersReduced() ? 0 : 180);
      onCancel();
      locked = false;
      lockedDelta = 0;
      return;
    }
    jumpTo(-width);
    onSettled();
    locked = false;
    lockedDelta = 0;
  }

  function onPointerDown(event) {
    if (destroyed || locked || gesture) return;
    if (!event.isPrimary) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (!viewport.contains(target)) return;
    if (!canStart()) return;
    // 日期格本身是 button，允许从日期内容起手；网格外真实动作按钮与输入控件不接管。
    if (target.closest('a, input, select, textarea, label, [role="tab"], summary')) return;
    if (target.closest('button') && !target.closest('.cal-cell')) return;
    const measured = viewport.clientWidth || 0;
    if (measured < 1) return;
    gesture = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      axis: null,
      deltaX: 0,
      width: measured,
      samples: [{ x: event.clientX, t: performance.now() }],
    };
    // 手势一开始就让背景预取让路，避免与当前切月的读取争用连接与主线程。
    onStart();
  }

  function onPointerMove(event) {
    const active = gesture;
    if (!active || active.id !== event.pointerId) return;
    const dx = event.clientX - active.startX;
    const dy = event.clientY - active.startY;
    if (!active.axis) {
      if (Math.abs(dx) < MONTH_SWIPE.lock && Math.abs(dy) < MONTH_SWIPE.lock) return;
      active.axis = Math.abs(dx) >= MONTH_SWIPE.lock && Math.abs(dx) > Math.abs(dy) * MONTH_SWIPE.ratio
        ? 'x'
        : 'y';
      if (active.axis === 'x') suppressClickUntil = performance.now() + MONTH_SWIPE.clickSuppressMs;
    }
    if (active.axis !== 'x') return;
    active.deltaX = dx;
    active.samples.push({ x: event.clientX, t: performance.now() });
    if (active.samples.length > 12) active.samples.shift();
    follow(dx);
  }

  function onPointerUp(event) {
    if (!gesture || gesture.id !== event.pointerId) return;
    void finish(false);
  }

  function onPointerCancel(event) {
    if (!gesture || gesture.id !== event.pointerId) return;
    void finish(true);
  }

  function onPointerDownSecond(event) {
    if (!gesture || event.isPrimary) return;
    if (gesture.id === event.pointerId) return;
    void finish(true);
  }

  function onClickCapture(event) {
    if (performance.now() >= suppressClickUntil) return;
    suppressClickUntil = 0;
    event.preventDefault();
    event.stopPropagation();
  }

  function onResize() {
    if (!track.isConnected) return;
    const next = viewport.clientWidth || 0;
    // 仅尺寸真的变化时才处理；页面刚显示时观察器的滞后回调不应打断进行中的手势。
    if (next === width) return;
    if (gesture) finish(true);
    width = next;
    jumpTo(-next - lockedDelta * next);
  }

  viewport.addEventListener('pointerdown', onPointerDown);
  viewport.addEventListener('pointerdown', onPointerDownSecond);
  viewport.addEventListener('click', onClickCapture, true);
  document.addEventListener('pointermove', onPointerMove, { passive: true });
  document.addEventListener('pointerup', onPointerUp, { passive: true });
  document.addEventListener('pointercancel', onPointerCancel, { passive: true });
  window.addEventListener('resize', onResize);
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(onResize) : null;
  observer?.observe(viewport);

  center();

  return {
    reset: () => {
      locked = false;
      reset();
    },
    center: () => { if (!gesture) center(); },
    isDragging: () => Boolean(gesture),
    isBusy: () => locked,
    destroy: () => {
      destroyed = true;
      gesture = null;
      observer?.disconnect();
      viewport.removeEventListener('pointerdown', onPointerDown);
      viewport.removeEventListener('pointerdown', onPointerDownSecond);
      viewport.removeEventListener('click', onClickCapture, true);
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('resize', onResize);
    },
  };
}
