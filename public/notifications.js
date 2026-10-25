// SmartPrint Real Notifications & Audio Alert Manager for Mobile Web App

let audioCtx = null;
let swRegistration = null;

export function initServiceWorker() {
  if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then(reg => {
      swRegistration = reg;
    }).catch(err => {
      console.warn('[Notifications] Service Worker registration failed:', err);
    });
  }
}

function getAudioContext() {
  if (typeof window === 'undefined') return null;
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      audioCtx = new AudioContextClass();
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

// Global unlock on first touch or click
if (typeof window !== 'undefined') {
  const unlockAudio = () => {
    getAudioContext();
    window.removeEventListener('click', unlockAudio);
    window.removeEventListener('touchstart', unlockAudio);
  };
  window.addEventListener('click', unlockAudio, { passive: true });
  window.addEventListener('touchstart', unlockAudio, { passive: true });
}

export function playChime(type = 'order') {
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    if (type === 'order') {
      // Pleasant multi-tone alert for new order
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(587.33, now); // D5
      osc.frequency.setValueAtTime(880.00, now + 0.12); // A5
      osc.frequency.setValueAtTime(1174.66, now + 0.24); // D6
      gain.gain.setValueAtTime(0.25, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
      osc.start(now);
      osc.stop(now + 0.6);
    } else if (type === 'payment') {
      // Crisp celebratory chime for verified payment
      osc.type = 'sine';
      osc.frequency.setValueAtTime(659.25, now); // E5
      osc.frequency.setValueAtTime(1046.50, now + 0.14); // C6
      gain.gain.setValueAtTime(0.3, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.55);
      osc.start(now);
      osc.stop(now + 0.55);
    } else if (type === 'complete') {
      // Smooth completion chime
      osc.type = 'sine';
      osc.frequency.setValueAtTime(523.25, now); // C5
      osc.frequency.setValueAtTime(659.25, now + 0.12); // E5
      osc.frequency.setValueAtTime(783.99, now + 0.24); // G5
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
      osc.start(now);
      osc.stop(now + 0.6);
    } else if (type === 'warning' || type === 'error') {
      // Attention buzzer
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(220, now);
      osc.frequency.setValueAtTime(196, now + 0.15);
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
      osc.start(now);
      osc.stop(now + 0.4);
    }
  } catch (err) {
    console.warn('[Audio] Could not play alert chime:', err);
  }
}

export function isNotificationSupported() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function getNotificationPermission() {
  if (!isNotificationSupported()) return 'unsupported';
  return Notification.permission;
}

export async function requestNotificationPermission() {
  if (!isNotificationSupported()) {
    throw new Error('Notifications are not supported in this browser.');
  }
  getAudioContext(); // Ensure audio context is ready
  const permission = await Notification.requestPermission();
  if (permission === 'granted') {
    playChime('payment');
    await sendRealNotification('🔔 SmartPrint Alerts Active', {
      body: 'You will receive real-time notifications for incoming orders and verified payments.',
      tag: 'smartprint-welcome',
      sound: true
    });
  }
  return permission;
}

export async function sendRealNotification(title, options = {}) {
  // 1. Play auditory alert
  if (options.chime !== false) {
    playChime(options.chimeType || 'order');
  }

  // 2. Mobile vibration if available
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    try {
      navigator.vibrate([200, 100, 200]);
    } catch {}
  }

  // 3. Dispatch Real System/OS Notification
  if (!isNotificationSupported() || Notification.permission !== 'granted') {
    return false;
  }

  const notificationOptions = {
    icon: '/logo.png',
    badge: '/logo.png',
    vibrate: [200, 100, 200],
    renotify: true,
    tag: options.tag || 'smartprint-alert-' + Date.now(),
    body: options.body || '',
    data: options.data || { url: '/#queue' }
  };

  try {
    if (swRegistration && 'showNotification' in swRegistration) {
      await swRegistration.showNotification(title, notificationOptions);
      return true;
    }
    new Notification(title, notificationOptions);
    return true;
  } catch (err) {
    console.warn('[Notifications] Could not display system notification:', err);
    return false;
  }
}
