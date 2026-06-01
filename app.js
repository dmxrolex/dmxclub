const cards = [...document.querySelectorAll(".card")];
const dots = [...document.querySelectorAll(".dot")];
const deck = document.querySelector("#deck");
const swipeSurface = document.querySelector(".phone") || deck;
const pager = document.querySelector(".pager");
const prevButtons = [...document.querySelectorAll('[data-action="prev"]')];
const nextButtons = [...document.querySelectorAll('[data-action="next"]')];
const swipeCue = document.querySelector(".swipe-cue");
const soundButton = document.querySelector(".sound-toggle");
const musicToggle = document.querySelector(".music-toggle");
const bgMusic = document.querySelector("#bg-music");
const allVideos = [...document.querySelectorAll("video, .anim-media")];
const touchMotionQuery = window.matchMedia("(hover: none), (pointer: coarse)");
const desktopFrameQuery = window.matchMedia("(min-width: 900px)");
const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
const interactiveNodes = [
  ...document.querySelectorAll("a, button, .base-tile, .feature-panel, .edge-row, .tool-row, .proof-strip a"),
];

let activeIndex = 0;
let nativeScrollMode = false;
let startX = 0;
let startY = 0;
let dragging = false;
let dragPointerId = null;
let releaseTimer = null;
let audioContext = null;
let soundEnabled = false;
let musicUserPaused = false;
let musicStarted = false;
let wheelLocked = false;
let hasSwipedOnce = false;
let motionSuspended = false;
let motionResumeTimer = null;
let dragFrame = 0;
let queuedDrag = null;
let dragVisualActive = false;
let dragTargetIndex = null;
let dragBounds = { width: 390, height: 700 };
let dragMoved = false;
let suppressClickUntil = 0;
let activeTouchId = null;
let scrollFrame = 0;
let nativeSyncTimer = 0;
let nativeTouchActive = false;
let nativeTouchStartTop = 0;
let nativeTouchStartY = 0;
let nativeScrollBurstActive = false;
let nativeScrollBurstStartTop = 0;
let nativeLastScrollTop = 0;
let nativeScrollDirection = 0;
let nativeProgrammaticScroll = false;
let nativeProgrammaticTimer = 0;
const lottieInstances = [];

// Velocity tracking
const velocityHistory = [];
const VELOCITY_WINDOW = 80; // ms to look back for velocity

// Physics constants
const RUBBER_BAND_FACTOR = 0.45;
const COMMIT_THRESHOLD = 0.24; // ratio of card height for a paper turn
const FLICK_VELOCITY = 0.6; // px/ms
const MAX_DRAG = 300;
const SPRING_TRANSITION = "transform 580ms cubic-bezier(0.34, 1.56, 0.64, 1), opacity 420ms ease, filter 420ms ease, box-shadow 420ms ease";
const PAPER_RELEASE_TRANSITION = "transform 420ms cubic-bezier(0.16, 1, 0.3, 1), opacity 320ms ease, filter 320ms ease, box-shadow 320ms ease";
const PAPER_RELEASE_TOUCH_TRANSITION = "transform 280ms cubic-bezier(0.16, 1, 0.3, 1), opacity 220ms ease";
const links = {
  prev: () => goTo(activeIndex - 1),
  next: () => goTo(activeIndex + 1),
};

function isInteractiveTarget(target) {
  return Boolean(target?.closest?.("a, button, input, textarea, select, [role='button']"));
}

function rememberVideoSource(video) {
  if (video.tagName === 'IMG') return;
  const source = video.getAttribute("src");
  if (source && !video.dataset.src) {
    video.dataset.src = source;
  }
}

function restoreVideoSource(video) {
  if (video.tagName === 'IMG') {
    if (video.getAttribute('src') !== video.dataset.src) {
      video.setAttribute('src', video.dataset.src);
    }
    return;
  }
  if (!video.dataset.src || video.getAttribute("src")) return;
  video.setAttribute("src", video.dataset.src);
  video.load();
}

function stripVideoSource(video) {
  if (video.tagName === 'IMG') {
    if (video.getAttribute('src') !== video.dataset.poster) {
      video.setAttribute('src', video.dataset.poster);
    }
    return;
  }
  const source = video.getAttribute("src");
  if (!source) return;
  if (!video.dataset.src) {
    video.dataset.src = source;
  }
  video.pause();
  video.removeAttribute("src");
  video.load();
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Rubber-band easing — drag gets harder past threshold
function rubberBand(distance, limit) {
  const ratio = distance / limit;
  if (Math.abs(ratio) <= 1) return distance;
  const sign = distance > 0 ? 1 : -1;
  const over = Math.abs(distance) - limit;
  return sign * (limit + over * RUBBER_BAND_FACTOR / (1 + over / limit));
}

function initAudio() {
  if (!audioContext) {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (AudioCtor) {
      audioContext = new AudioCtor();
    }
  }
  if (audioContext?.state === "suspended") {
    audioContext.resume();
  }
}

function blip(kind = "tap") {
  if (!soundEnabled || !audioContext) return;

  const now = audioContext.currentTime;
  const osc = audioContext.createOscillator();
  const gain = audioContext.createGain();
  const filter = audioContext.createBiquadFilter();

  const settings = {
    tap: [460, 0.035, 0.035],
    swipe: [190, 0.055, 0.05],
    select: [640, 0.045, 0.04],
    open: [820, 0.07, 0.055],
  }[kind];

  osc.type = kind === "swipe" ? "triangle" : "sine";
  osc.frequency.setValueAtTime(settings[0], now);
  osc.frequency.exponentialRampToValueAtTime(settings[0] * 1.75, now + settings[1]);
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(1800, now);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(settings[2], now + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + settings[1] + 0.05);

  osc.connect(filter);
  filter.connect(gain);
  gain.connect(audioContext.destination);
  osc.start(now);
  osc.stop(now + settings[1] + 0.07);
}

function setMusicState(isPlaying) {
  if (!musicToggle) return;
  musicToggle.classList.toggle("is-playing", isPlaying);
  musicToggle.classList.toggle("is-paused", !isPlaying);
  musicToggle.setAttribute("aria-pressed", String(isPlaying));
  musicToggle.setAttribute("aria-label", isPlaying ? "Pause music" : "Play music");
}

async function tryPlayMusic() {
  if (!bgMusic || musicUserPaused) return false;
  bgMusic.volume = 0.18;

  try {
    await bgMusic.play();
    musicStarted = true;
    setMusicState(true);
    return true;
  } catch {
    setMusicState(false);
    return false;
  }
}

function pauseMusic() {
  if (!bgMusic) return;
  musicUserPaused = true;
  bgMusic.pause();
  setMusicState(false);
}

function toggleMusic(event) {
  event?.stopPropagation();
  if (!bgMusic) return;

  if (!bgMusic.paused) {
    pauseMusic();
    return;
  }

  musicUserPaused = false;
  tryPlayMusic();
}

function unlockMusicOnGesture(event) {
  if (event?.target?.closest?.(".music-toggle")) return;
  if (!musicStarted && !musicUserPaused) tryPlayMusic();
}

function setCardClasses() {
  cards.forEach((card, index) => {
    const diff = index - activeIndex;
    card.classList.remove("is-active", "is-prev", "is-next", "is-far-prev", "is-far-next", "is-far");

    if (diff === 0) {
      card.classList.add("is-active");
    } else if (diff === -1) {
      card.classList.add("is-prev");
    } else if (diff === 1) {
      card.classList.add("is-next");
    } else if (diff === -2) {
      card.classList.add("is-far-prev");
    } else if (diff === 2) {
      card.classList.add("is-far-next");
    } else {
      card.classList.add("is-far");
    }

    card.setAttribute("aria-hidden", diff === 0 ? "false" : "true");
    card.style.pointerEvents = nativeScrollMode || diff === 0 ? "auto" : "none";
  });

  dots.forEach((dot, index) => {
    const isActive = index === activeIndex;
    dot.classList.toggle("is-active", isActive);
    dot.classList.toggle("is-complete", index < activeIndex);
    dot.setAttribute("aria-current", isActive ? "true" : "false");
  });

  if (pager) {
    pager.style.setProperty("--active-index", activeIndex);
    pager.style.setProperty("--dot-count", cards.length);
    const progress = cards.length > 1 ? activeIndex / (cards.length - 1) : 0;
    pager.style.setProperty("--pager-hotspot", `${8 + progress * 84}%`);
    pager.style.setProperty("--pager-progress", progress.toFixed(3));
  }

  if (swipeCue) {
    let cueText = "Swipe up for next";
    if (activeIndex === cards.length - 1) {
      cueText = "Swipe down to go back";
    } else if (activeIndex > 0) {
      cueText = "Swipe up or down";
    }
    swipeCue.querySelector("span").textContent = cueText;
  }

  prevButtons.forEach((button) => {
    const isDisabled = activeIndex === 0;
    button.classList.toggle("is-disabled", isDisabled);
    button.setAttribute("aria-disabled", String(isDisabled));
  });

  syncMotion();
}

function applyInteractionMode() {
  nativeScrollMode = false;
  document.documentElement.classList.toggle("is-native-scroll", nativeScrollMode);
  document.documentElement.classList.remove("is-native-moving");

  nativeTouchActive = false;
  nativeScrollBurstActive = false;
  nativeScrollDirection = 0;
  nativeProgrammaticScroll = false;

  if (nativeSyncTimer) {
    window.clearTimeout(nativeSyncTimer);
    nativeSyncTimer = 0;
  }
  if (nativeProgrammaticTimer) {
    window.clearTimeout(nativeProgrammaticTimer);
    nativeProgrammaticTimer = 0;
  }

  deck.scrollTo({ top: 0, left: 0, behavior: "auto" });
}

function setMotionSuspended(suspended) {
  if (motionSuspended === suspended) return;
  motionSuspended = suspended;
  document.documentElement.classList.toggle("is-motion-quiet", suspended);
  syncMotion();
}

function scheduleMotionResume(delay = 0) {
  if (motionResumeTimer) {
    window.clearTimeout(motionResumeTimer);
  }
  motionResumeTimer = window.setTimeout(() => {
    motionResumeTimer = null;
    setMotionSuspended(false);
  }, delay);
}

function setDragTarget(index) {
  if (dragTargetIndex === index) return;
  if (dragTargetIndex !== null) {
    cards[dragTargetIndex]?.classList.remove("is-drag-target");
  }
  dragTargetIndex = index;
  if (dragTargetIndex !== null) {
    cards[dragTargetIndex]?.classList.add("is-drag-target");
  }
}

function hideSwipeCue() {
  if (!hasSwipedOnce && swipeCue) {
    hasSwipedOnce = true;
    swipeCue.classList.add("is-hidden");
    swipeCue.setAttribute("aria-hidden", "true");
  }
}

function pulseActiveDot() {
  const dot = dots[activeIndex];
  if (!dot) return;
  dot.classList.remove("just-changed");
  void dot.offsetWidth;
  dot.classList.add("just-changed");
  setTimeout(() => dot.classList.remove("just-changed"), 760);
}

function resolveTargetIndex(index) {
  return clamp(index, 0, cards.length - 1);
}

function getNativePageHeight() {
  return deck.clientHeight || window.innerHeight || 1;
}

function getNativeScrollTop(index) {
  return index * getNativePageHeight();
}

function getNativeScrollIndex() {
  return clamp(Math.round(deck.scrollTop / getNativePageHeight()), 0, cards.length - 1);
}

function completeNativeProgrammaticScroll(index, targetTop) {
  nativeProgrammaticScroll = false;
  nativeProgrammaticTimer = 0;
  nativeScrollBurstActive = false;
  nativeScrollDirection = 0;
  document.documentElement.classList.remove("is-native-moving");

  if (Math.abs(deck.scrollTop - targetTop) > 2) {
    deck.scrollTo({ top: targetTop, behavior: "auto" });
  }

  if (index !== activeIndex) {
    activeIndex = index;
    setCardClasses();
    pulseActiveDot();
    hideSwipeCue();
  }

  scheduleMotionResume(80);
}

function scrollNativeToIndex(index, behavior = "smooth") {
  if (!nativeScrollMode) return;
  const nextIndex = clamp(index, 0, cards.length - 1);
  const targetTop = getNativeScrollTop(nextIndex);
  const changed = nextIndex !== activeIndex;

  if (nativeSyncTimer) {
    window.clearTimeout(nativeSyncTimer);
    nativeSyncTimer = 0;
  }
  if (nativeProgrammaticTimer) {
    window.clearTimeout(nativeProgrammaticTimer);
    nativeProgrammaticTimer = 0;
  }

  nativeProgrammaticScroll = true;
  document.documentElement.classList.add("is-native-moving");
  setMotionSuspended(true);

  activeIndex = nextIndex;
  setCardClasses();
  if (changed) {
    pulseActiveDot();
    hideSwipeCue();
  }

  deck.scrollTo({ top: targetTop, behavior });
  nativeProgrammaticTimer = window.setTimeout(
    () => completeNativeProgrammaticScroll(nextIndex, targetTop),
    behavior === "smooth" ? 440 : 90,
  );
}

function syncNativeActivePage() {
  if (!nativeScrollMode) return;
  const height = getNativePageHeight();
  const currentTop = deck.scrollTop;
  const travel = currentTop - nativeScrollBurstStartTop;
  const threshold = Math.min(180, height * 0.16);
  let nextIndex = getNativeScrollIndex();

  if (nativeScrollBurstActive && Math.abs(travel) > threshold && nativeScrollDirection !== 0) {
    nextIndex = nativeScrollDirection > 0
      ? Math.ceil(currentTop / height)
      : Math.floor(currentTop / height);
    nextIndex = clamp(nextIndex, 0, cards.length - 1);
  }

  nativeScrollBurstActive = false;
  nativeScrollDirection = 0;

  if (Math.abs(currentTop - getNativeScrollTop(nextIndex)) > 2) {
    scrollNativeToIndex(nextIndex);
    return;
  }

  completeNativeProgrammaticScroll(nextIndex, getNativeScrollTop(nextIndex));
}

function scheduleNativeSync(delay = 180) {
  if (nativeSyncTimer) {
    window.clearTimeout(nativeSyncTimer);
  }
  nativeSyncTimer = window.setTimeout(() => {
    nativeSyncTimer = 0;
    syncNativeActivePage();
  }, delay);
}

function snapNativeToIndex(index, behavior = "smooth") {
  if (!nativeScrollMode) return;
  scrollNativeToIndex(index, behavior);
}

function handleNativeTouchStart(event) {
  if (!nativeScrollMode || event.touches.length !== 1) return;
  nativeTouchActive = true;
  nativeTouchStartTop = deck.scrollTop;
  nativeTouchStartY = event.touches[0].clientY;
  if (nativeSyncTimer) {
    window.clearTimeout(nativeSyncTimer);
    nativeSyncTimer = 0;
  }
  setMotionSuspended(true);
}

function handleNativeTouchEnd(event) {
  if (!nativeScrollMode || !nativeTouchActive) return;
  nativeTouchActive = false;

  const height = getNativePageHeight();
  const startIndex = clamp(Math.round(nativeTouchStartTop / height), 0, cards.length - 1);
  const scrollDelta = deck.scrollTop - nativeTouchStartTop;
  const touch = event.changedTouches?.[0];
  const fingerDelta = touch ? nativeTouchStartY - touch.clientY : scrollDelta;
  const threshold = Math.min(180, height * 0.16);

  let targetIndex = getNativeScrollIndex();
  if (Math.abs(scrollDelta) > threshold || Math.abs(fingerDelta) > threshold) {
    targetIndex = startIndex + (scrollDelta > 0 || fingerDelta > 0 ? 1 : -1);
  }

  snapNativeToIndex(targetIndex);
}

function goTo(index, sound = true) {
  const nextIndex = clamp(index, 0, cards.length - 1);
  if (nextIndex === activeIndex) return;
  if (nativeScrollMode) {
    snapNativeToIndex(nextIndex);
    if (sound) blip("swipe");
    return;
  }
  activeIndex = nextIndex;
  setCardClasses();
  pulseActiveDot();
  if (sound) blip("swipe");
  hideSwipeCue();
}

function updateActiveFromScroll() {
  scrollFrame = 0;
  if (!nativeScrollMode) return;
  const nextIndex = getNativeScrollIndex();
  if (nextIndex !== activeIndex) {
    activeIndex = nextIndex;
    setCardClasses();
    pulseActiveDot();
    hideSwipeCue();
  }
}

function handleNativeScroll() {
  if (!nativeScrollMode) return;
  const currentTop = deck.scrollTop;

  if (!nativeProgrammaticScroll) {
    document.documentElement.classList.add("is-native-moving");
    if (!nativeScrollBurstActive) {
      nativeScrollBurstActive = true;
      nativeScrollBurstStartTop = currentTop;
      nativeLastScrollTop = currentTop;
      nativeScrollDirection = 0;
    } else {
      if (currentTop > nativeLastScrollTop + 2) {
        nativeScrollDirection = 1;
      } else if (currentTop < nativeLastScrollTop - 2) {
        nativeScrollDirection = -1;
      }
      nativeLastScrollTop = currentTop;
    }
  }

  setMotionSuspended(true);
  if (nativeProgrammaticScroll) {
    scheduleMotionResume(520);
  } else if (nativeTouchActive) {
    scheduleMotionResume(560);
  } else {
    scheduleMotionResume(260);
    scheduleNativeSync(280);
  }
  if (!scrollFrame) {
    scrollFrame = requestAnimationFrame(updateActiveFromScroll);
  }
}

// ── Physics-based drag ──

function trackVelocity(clientX, clientY) {
  const now = performance.now();
  velocityHistory.push({ x: clientX, y: clientY, t: now });
  // Keep only recent entries
  while (velocityHistory.length > 0 && now - velocityHistory[0].t > VELOCITY_WINDOW) {
    velocityHistory.shift();
  }
}

function getVelocity() {
  if (velocityHistory.length < 2) return { vx: 0, vy: 0 };
  const first = velocityHistory[0];
  const last = velocityHistory[velocityHistory.length - 1];
  if (performance.now() - last.t > VELOCITY_WINDOW) return { vx: 0, vy: 0 };
  const dt = last.t - first.t;
  if (dt === 0) return { vx: 0, vy: 0 };
  return {
    vx: (last.x - first.x) / dt,
    vy: (last.y - first.y) / dt,
  };
}

function setDragOffset(deltaX, deltaY) {
  const active = cards[activeIndex];
  if (!active) return;

  const vertical = Math.abs(deltaY) >= Math.abs(deltaX);
  const canTurnForward = vertical && deltaY < 0 && activeIndex < cards.length - 1;
  const canTurnBack = vertical && deltaY > 0 && activeIndex > 0;
  if (!canTurnForward && !canTurnBack) {
    if (dragVisualActive) {
      clearAllInlineStyles();
      dragVisualActive = false;
    }
    setDragTarget(null);
    return;
  }

  dragVisualActive = true;
  const direction = canTurnForward ? "next" : "prev";
  const targetIndex = activeIndex + (canTurnForward ? 1 : -1);
  setDragTarget(targetIndex);
  const rawDelta = vertical ? deltaY : deltaX;
  const cardHeight = dragBounds.height || active.offsetHeight || 700;
  const cardWidth = dragBounds.width || active.offsetWidth || 390;
  const paperLimit = vertical ? cardHeight * 0.56 : cardWidth * 0.45;
  const limited = rubberBand(rawDelta, Math.min(MAX_DRAG, paperLimit));
  const progress = clamp(Math.abs(limited) / (vertical ? cardHeight * COMMIT_THRESHOLD : cardWidth * 0.28), 0, 1);
  const visualX = vertical ? deltaX * 0.08 : limited * 0.74;
  const visualY = vertical ? limited * 0.92 : deltaY * 0.08;
  const touchMode = touchMotionQuery.matches;

  active.style.transition = "none";
  active.classList.add("is-lifting");
  active.style.setProperty("--drag-progress", progress.toFixed(3));
  if (!touchMode) {
    active.style.setProperty("--parallax-x", `${(-visualX * 0.045).toFixed(2)}px`);
    active.style.setProperty("--parallax-y", `${(-visualY * 0.045).toFixed(2)}px`);
  }

  if (vertical) {
    const tiltX = clamp(limited * -0.022, -7, 7);
    const tiltY = clamp(deltaX * 0.018, -3, 3);
    const scaleDown = 1 - progress * (touchMode ? 0.014 : 0.025);
    active.style.transform = touchMode
      ? `translate3d(0, ${visualY}px, 0) scale(${scaleDown})`
      : `translate3d(${visualX}px, ${visualY}px, 0) scale(${scaleDown}) rotateX(${tiltX}deg) rotateY(${tiltY}deg)`;
    active.style.opacity = "1";

    if (!touchMode) {
      const shadowY = lerp(24, 62, progress);
      const shadowBlur = lerp(60, 150, progress);
      const shadowAlpha = lerp(0.54, 0.82, progress);
      active.style.boxShadow = `0 ${shadowY}px ${shadowBlur}px rgba(0, 0, 0, ${shadowAlpha}), 0 0 0 1px rgba(255, 255, 255, 0.08), inset 0 1px rgba(255, 255, 255, 0.16)`;
    }

    interpolateAdjacentCard(targetIndex, progress, direction);
  }
}

function interpolateAdjacentCard(index, progress, direction) {
  const card = cards[index];
  if (!card) return;

  card.style.transition = "none";
  const eased = 1 - Math.pow(1 - progress, 2); // ease-out quad
  const touchMode = touchMotionQuery.matches;
  card.style.zIndex = "5";

  if (direction === "next") {
    const scale = lerp(0.965, 1, eased);
    const opacity = lerp(0.72, 1, eased);
    const y = lerp(8, 0, eased);
    const rotX = touchMode ? 0 : lerp(3, 0, eased);
    const blur = touchMode ? 0 : lerp(0.8, 0, eased);
    const brightness = lerp(0.82, 1, eased);
    card.style.transform = touchMode ? `translateY(${y}%) scale(${scale})` : `translateY(${y}%) scale(${scale}) rotateX(${rotX}deg)`;
    card.style.opacity = opacity;
    card.style.filter = touchMode ? "" : `blur(${blur}px) brightness(${brightness})`;
  } else {
    const scale = lerp(0.965, 1, eased);
    const opacity = lerp(0.68, 1, eased);
    const y = lerp(-8, 0, eased);
    const rotX = touchMode ? 0 : lerp(-3, 0, eased);
    const blur = touchMode ? 0 : lerp(0.8, 0, eased);
    const brightness = lerp(0.82, 1, eased);
    card.style.transform = touchMode ? `translateY(${y}%) scale(${scale})` : `translateY(${y}%) scale(${scale}) rotateX(${rotX}deg)`;
    card.style.opacity = opacity;
    card.style.filter = touchMode ? "" : `blur(${blur}px) brightness(${brightness})`;
  }

  if (touchMode) return;

  // Also pull the card 2 spots away closer
  const farIndex = direction === "next" ? index + 1 : index - 1;
  const farCard = cards[farIndex];
  if (farCard) {
    farCard.style.transition = "none";
    if (direction === "next") {
      const farScale = lerp(0.9, 0.965, eased);
      const farOpacity = lerp(0.16, 0.58, eased);
      const farY = lerp(20, 8, eased);
      const farRotX = lerp(7, 3, eased);
      const farBlur = lerp(3, 0.8, eased);
      const farBright = lerp(0.58, 0.82, eased);
      farCard.style.transform = `translateY(${farY}%) scale(${farScale}) rotateX(${farRotX}deg)`;
      farCard.style.opacity = farOpacity;
      farCard.style.filter = `blur(${farBlur}px) brightness(${farBright})`;
    } else {
      const farScale = lerp(0.9, 0.965, eased);
      const farOpacity = lerp(0.16, 0.54, eased);
      const farY = lerp(-20, -8, eased);
      const farRotX = lerp(-7, -3, eased);
      const farBlur = lerp(3, 0.8, eased);
      const farBright = lerp(0.58, 0.82, eased);
      farCard.style.transform = `translateY(${farY}%) scale(${farScale}) rotateX(${farRotX}deg)`;
      farCard.style.opacity = farOpacity;
      farCard.style.filter = `blur(${farBlur}px) brightness(${farBright})`;
    }
  }
}

function clearAllInlineStyles() {
  if (releaseTimer) {
    window.clearTimeout(releaseTimer);
    releaseTimer = null;
  }
  const relevantCards = touchMotionQuery.matches
    ? [...new Set([
        cards[activeIndex],
        dragTargetIndex !== null ? cards[dragTargetIndex] : null,
        ...cards.filter((card) => card.classList.contains("is-drag-target")),
      ].filter(Boolean))]
    : cards;

  relevantCards.forEach((card) => {
    card.style.transition = "";
    card.style.transform = "";
    card.style.opacity = "";
    card.style.filter = "";
    card.style.boxShadow = "";
    card.style.zIndex = "";
    card.style.removeProperty("--drag-progress");
    card.style.removeProperty("--parallax-x");
    card.style.removeProperty("--parallax-y");
    card.classList.remove("is-lifting");
    card.classList.remove("is-drag-target");
  });
  dragVisualActive = false;
  dragTargetIndex = null;
}

function commitDrag(targetIndex, deltaX, deltaY, velocity) {
  const active = cards[activeIndex];
  if (!active) return;

  const target = resolveTargetIndex(targetIndex);
  if (target === activeIndex) {
    springBack();
    return;
  }

  const movingForward = target > activeIndex;
  const directionX = Math.sign(deltaX || velocity.vx || 0);
  const directionY = deltaY === 0 ? (movingForward ? -1 : 1) : Math.sign(deltaY);
  const exitLimit = (active.offsetHeight || 700) * 0.86;
  const exitX = clamp(deltaX * 1.15 + velocity.vx * 180, -220, 220);
  const exitY = clamp(deltaY * 1.45 + velocity.vy * 260, -exitLimit, exitLimit);
  const rotateX = clamp(-directionY * 12, -12, 12);
  const rotateY = clamp(directionX * 10, -10, 10);
  const touchMode = touchMotionQuery.matches;

  active.classList.add("is-lifting");
  active.style.transition = touchMode ? PAPER_RELEASE_TOUCH_TRANSITION : PAPER_RELEASE_TRANSITION;
  active.style.transform = touchMode
    ? `translate3d(0, ${exitY}px, 0) scale(0.92)`
    : `translate3d(${exitX}px, ${exitY}px, 0) scale(0.84) rotateX(${rotateX}deg) rotateY(${rotateY}deg)`;
  active.style.opacity = "0.08";
  if (!touchMode) {
    active.style.filter = "blur(5px) brightness(0.68)";
    active.style.boxShadow = "0 48px 120px rgba(0, 0, 0, 0.72), inset 0 1px rgba(255, 255, 255, 0.16)";
  }

  const releaseCards = touchMode ? [cards[target]].filter(Boolean) : cards;
  releaseCards.forEach((card, index) => {
    if (!touchMode && index === activeIndex) return;
    if (touchMode && card === active) return;
    card.style.transition = touchMode ? PAPER_RELEASE_TOUCH_TRANSITION : SPRING_TRANSITION;
  });

  releaseTimer = window.setTimeout(() => {
    releaseTimer = null;
    clearAllInlineStyles();
    goTo(target);
    deck.classList.remove("is-dragging");
    if (touchMode) scheduleMotionResume(80);
  }, touchMode ? 260 : 390);
}

function releaseDrag(deltaX, deltaY) {
  const active = cards[activeIndex];
  if (!active) return;

  const vertical = Math.abs(deltaY) >= Math.abs(deltaX);
  const velocity = getVelocity();
  const { vx, vy } = velocity;

  if (vertical) {
    const cardHeight = active.offsetHeight || 600;
    const threshold = cardHeight * COMMIT_THRESHOLD;
    const isForwardFlick = vy < -FLICK_VELOCITY;
    const isBackFlick = vy > FLICK_VELOCITY;
    const pastThreshold = Math.abs(deltaY) > threshold;

    if ((isForwardFlick || pastThreshold) && deltaY < 0) {
      commitDrag(activeIndex + 1, deltaX, deltaY, velocity);
    } else if ((isBackFlick || pastThreshold) && deltaY > 0) {
      commitDrag(activeIndex - 1, deltaX, deltaY, velocity);
    } else {
      springBack();
    }
  } else {
    springBack();
  }
}

function springBack() {
  const touchMode = touchMotionQuery.matches;
  // Apply spring transition to all cards and let CSS classes handle positioning
  const relevantCards = touchMode
    ? [...new Set([
        cards[activeIndex],
        dragTargetIndex !== null ? cards[dragTargetIndex] : null,
        ...cards.filter((card) => card.classList.contains("is-drag-target")),
      ].filter(Boolean))]
    : cards;

  relevantCards.forEach((card) => {
    card.style.transition = touchMode ? PAPER_RELEASE_TOUCH_TRANSITION : SPRING_TRANSITION;
    card.style.transform = "";
    card.style.opacity = "";
    card.style.filter = "";
    card.style.boxShadow = "";
    card.style.zIndex = "";
    card.style.removeProperty("--drag-progress");
    card.style.removeProperty("--parallax-x");
    card.style.removeProperty("--parallax-y");
    card.classList.remove("is-lifting");
  });

  // After transition ends, clean up inline transitions
  setTimeout(() => {
    relevantCards.forEach((card) => {
      card.style.transition = "";
    });
    deck.classList.remove("is-dragging");
    if (touchMode) scheduleMotionResume(60);
  }, touchMode ? 300 : 600);
}

function beginDrag(clientX, clientY, pointerId = null) {
  if (nativeScrollMode) return;
  dragging = true;
  startX = clientX;
  startY = clientY;
  dragPointerId = pointerId;
  dragVisualActive = false;
  dragMoved = false;
  const active = cards[activeIndex];
  dragBounds = {
    width: active?.offsetWidth || 390,
    height: active?.offsetHeight || 700,
  };
  velocityHistory.length = 0;
  trackVelocity(clientX, clientY);
  deck.classList.add("is-dragging");
  if (touchMotionQuery.matches) {
    setMotionSuspended(true);
  }
}

function updateDragPoint(clientX, clientY) {
  if (!dragging || nativeScrollMode) return;
  const deltaX = clientX - startX;
  const deltaY = clientY - startY;
  if (Math.abs(deltaX) > 8 || Math.abs(deltaY) > 8) {
    dragMoved = true;
  }
  trackVelocity(clientX, clientY);
  queuedDrag = { deltaX, deltaY };
  if (!dragFrame) {
    dragFrame = requestAnimationFrame(() => {
      dragFrame = 0;
      if (!dragging || !queuedDrag) return;
      setDragOffset(queuedDrag.deltaX, queuedDrag.deltaY);
    });
  }
}

function moveDrag(event) {
  if (!dragging) return;
  if (dragPointerId !== null && event.pointerId !== dragPointerId) return;
  event.preventDefault();
  updateDragPoint(event.clientX, event.clientY);
}

function finishDragPoint(clientX, clientY) {
  if (!dragging || nativeScrollMode) return;
  dragging = false;
  dragPointerId = null;

  const deltaX = clientX - startX;
  const deltaY = clientY - startY;
  queuedDrag = null;
  if (dragFrame) {
    cancelAnimationFrame(dragFrame);
    dragFrame = 0;
  }

  if (Math.abs(deltaX) < 5 && Math.abs(deltaY) < 5) {
    // Tap, not drag
    clearAllInlineStyles();
    deck.classList.remove("is-dragging");
    scheduleMotionResume(40);
    blip("tap");
    return;
  }

  if (dragMoved) {
    suppressClickUntil = performance.now() + 450;
  }
  releaseDrag(deltaX, deltaY);
}

function finishDrag(event) {
  if (!dragging) return;
  if (dragPointerId !== null && event.pointerId !== dragPointerId) return;
  finishDragPoint(event.clientX, event.clientY);
}

function cancelDrag(event) {
  if (nativeScrollMode) return;
  if (event?.pointerType === "touch" && activeTouchId !== null) return;
  if (!dragging) return;
  dragging = false;
  dragPointerId = null;
  activeTouchId = null;
  queuedDrag = null;
  if (dragFrame) {
    cancelAnimationFrame(dragFrame);
    dragFrame = 0;
  }
  springBack();
}

function countUpStats() {
  document.querySelectorAll("[data-count]").forEach((node) => {
    const target = Number(node.dataset.count);
    let frame = 0;
    const frames = 34;
    const tick = () => {
      frame += 1;
      const progress = 1 - Math.pow(1 - frame / frames, 3);
      node.textContent = `${Math.round(target * progress)}+`;
      if (frame < frames) requestAnimationFrame(tick);
    };
    tick();
  });
}

function initLottie() {
  if (!window.lottie) {
    document.documentElement.classList.add("no-lottie");
    return;
  }

  document.querySelectorAll("[data-lottie]").forEach((element) => {
    const animation = window.lottie.loadAnimation({
      container: element,
      renderer: "svg",
      loop: true,
      autoplay: false,
      path: element.dataset.lottie,
      rendererSettings: {
        preserveAspectRatio: "xMidYMid meet",
        progressiveLoad: true,
      },
    });
    lottieInstances.push({ element, animation });
  });

  syncMotion();
}

function syncMotion() {
  const touchMode = touchMotionQuery.matches;
  const desktopMode = desktopFrameQuery.matches;
  const reduceMotion = document.hidden || motionSuspended || (touchMode && reducedMotionQuery.matches);

  allVideos.forEach((video) => {
    rememberVideoSource(video);

    const card = video.closest(".card");
    const dot = video.closest(".dot");
    const isActiveCardVideo = card?.classList.contains("is-active") ?? false;
    const isPagerVideo = Boolean(dot);
    const isActivePagerVideo = dot?.classList.contains("is-active") ?? false;
    const isDesktopFrameVideo = video.classList.contains("desktop-loop");
    const shouldPlay = !reduceMotion && (
      isActiveCardVideo ||
      (isPagerVideo && (isActivePagerVideo || desktopMode)) ||
      (isDesktopFrameVideo && desktopMode)
    );

    if (video.tagName !== 'IMG') {
      video.muted = true;
      video.playsInline = true;
    }

    if (touchMode && (isDesktopFrameVideo || (card && !isActiveCardVideo) || (isPagerVideo && !isActivePagerVideo))) {
      stripVideoSource(video);
      return;
    }

    if (shouldPlay) {
      restoreVideoSource(video);
      if (video.tagName !== 'IMG') {
        if (video.preload !== "auto") {
          video.preload = "auto";
        }
        if (video.readyState < 2 && !video.dataset.loadRequested) {
          video.dataset.loadRequested = "true";
          video.load();
        }
        const playPromise = video.play();
        if (playPromise?.catch) playPromise.catch(() => {});
      }
    } else {
      if (video.tagName !== 'IMG') {
        video.pause();
      } else {
        stripVideoSource(video);
      }
    }
  });

  lottieInstances.forEach(({ element, animation }) => {
    const card = element.closest(".card");
    const shouldPlay = !reduceMotion && (!card || card.classList.contains("is-active"));
    if (shouldPlay) {
      animation.play();
    } else {
      animation.pause();
    }
  });
}

// ── Event listeners ──

prevButtons.forEach((button) => {
  button.addEventListener("click", () => {
    if (activeIndex === 0) return;
    initAudio();
    links.prev();
  });
});

nextButtons.forEach((button) => {
  button.addEventListener("click", () => {
    initAudio();
    links.next();
  });
});

if (soundButton) {
  soundButton.addEventListener("click", () => {
    initAudio();
    soundEnabled = !soundEnabled;
    soundButton.classList.toggle("is-on", soundEnabled);
    soundButton.setAttribute("aria-pressed", String(soundEnabled));
    soundButton.setAttribute("aria-label", soundEnabled ? "Disable sound" : "Enable sound");
    blip("select");
  });
}

if (musicToggle) {
  musicToggle.addEventListener("click", toggleMusic);
}

dots.forEach((dot) => {
  dot.addEventListener("click", () => {
    initAudio();
    goTo(Number(dot.dataset.go));
  });
});

swipeSurface.addEventListener("pointerdown", (event) => {
  if (nativeScrollMode) return;
  if (isInteractiveTarget(event.target)) return;
  if (event.pointerType === "touch") {
    activeTouchId = null;
  }
  beginDrag(event.clientX, event.clientY, event.pointerId);
  try {
    swipeSurface.setPointerCapture(event.pointerId);
  } catch {
    dragPointerId = null;
  }
});

swipeSurface.addEventListener(
  "touchstart",
  (event) => {
    if (nativeScrollMode) {
      handleNativeTouchStart(event);
      return;
    }
    if (isInteractiveTarget(event.target)) return;
    if (dragging) return;
    if (activeTouchId !== null || event.touches.length !== 1) return;
    const touch = event.changedTouches[0];
    activeTouchId = touch.identifier;
    beginDrag(touch.clientX, touch.clientY, null);
  },
  { passive: true },
);

swipeSurface.addEventListener(
  "touchmove",
  (event) => {
    if (nativeScrollMode) return;
    if (activeTouchId === null) return;
    const touch = [...event.changedTouches].find((item) => item.identifier === activeTouchId);
    if (!touch) return;
    event.preventDefault();
    updateDragPoint(touch.clientX, touch.clientY);
  },
  { passive: false },
);

swipeSurface.addEventListener(
  "touchend",
  (event) => {
    if (nativeScrollMode) {
      handleNativeTouchEnd(event);
      return;
    }
    if (activeTouchId === null) return;
    const touch = [...event.changedTouches].find((item) => item.identifier === activeTouchId);
    if (!touch) return;
    activeTouchId = null;
    finishDragPoint(touch.clientX, touch.clientY);
  },
  { passive: true },
);

swipeSurface.addEventListener(
  "touchcancel",
  (event) => {
    if (nativeScrollMode) {
      handleNativeTouchEnd(event);
      return;
    }
    cancelDrag(event);
  },
  { passive: true },
);
swipeSurface.addEventListener("dragstart", (event) => event.preventDefault());
swipeSurface.addEventListener("pointermove", moveDrag);
swipeSurface.addEventListener("pointerup", finishDrag);
swipeSurface.addEventListener("pointercancel", cancelDrag);
swipeSurface.addEventListener("lostpointercapture", cancelDrag);
deck.addEventListener("scroll", handleNativeScroll, { passive: true });
swipeSurface.addEventListener(
  "click",
  (event) => {
    if (performance.now() < suppressClickUntil) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  },
  true,
);

window.addEventListener(
  "wheel",
  (event) => {
    if (nativeScrollMode) return;
    if (wheelLocked) return;
    const direction = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    if (Math.abs(direction) < 16) return;
    wheelLocked = true;
    goTo(activeIndex + (direction > 0 ? 1 : -1));
    setTimeout(() => {
      wheelLocked = false;
    }, 620);
  },
  { passive: true },
);

window.addEventListener("keydown", (event) => {
  unlockMusicOnGesture();
  if (["ArrowDown", "PageDown", " "].includes(event.key)) {
    event.preventDefault();
    initAudio();
    links.next();
  } else if (["ArrowUp", "PageUp"].includes(event.key)) {
    event.preventDefault();
    initAudio();
    links.prev();
  }
});

[touchMotionQuery, desktopFrameQuery, reducedMotionQuery].forEach((query) => {
  const handler = () => {
    applyInteractionMode();
    setCardClasses();
    syncMotion();
  };
  if (query.addEventListener) {
    query.addEventListener("change", handler);
  } else if (query.addListener) {
    query.addListener(handler);
  }
});

document.addEventListener("visibilitychange", syncMotion);

["pointerdown", "touchstart"].forEach((type) => {
  window.addEventListener(type, unlockMusicOnGesture, { passive: true });
});

interactiveNodes.forEach((node) => {
  if (!touchMotionQuery.matches) {
    node.addEventListener("mouseenter", () => blip("tap"));
  }
  node.addEventListener("click", () => {
    node.classList.remove("jelly-pop");
    void node.offsetWidth;
    node.classList.add("jelly-pop");
    blip(node.tagName === "A" ? "open" : "select");
  });
});

// ── Initialize ──
applyInteractionMode();
setCardClasses();
countUpStats();
window.addEventListener("load", () => {
  tryPlayMusic();
  if ('requestIdleCallback' in window) {
    requestIdleCallback(initLottie);
  } else {
    setTimeout(initLottie, 200);
  }
});
