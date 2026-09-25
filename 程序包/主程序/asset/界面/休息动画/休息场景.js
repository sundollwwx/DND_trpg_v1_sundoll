(function (global) {
  'use strict';

  const scriptBase = new URL('.', document.currentScript.src);
  const imageUrl = (name) => new URL(name, scriptBase).href;
  const audioUrl = (name) => new URL('./音频/' + name + '.m4a?v=20260906-rest-location-v2', scriptBase).href;

  const SCENES = Object.freeze({
    'short-outdoor': Object.freeze({
      id: 'short-outdoor', kind: 'short', label: '室外林地', icon: '🔥',
      subtitle: '林间停驻，整备再启', effect: 'embers',
      image: imageUrl('短休-室外林地.jpg'),
      audio: audioUrl('短休·林间整备'),
    }),
    'short-indoor': Object.freeze({
      id: 'short-indoor', kind: 'short', label: '室内酒馆', icon: '☕',
      subtitle: '酒馆暖火，稍作喘息', effect: 'firelight',
      image: imageUrl('短休-室内酒馆.jpg'),
      audio: audioUrl('短休·炉边小憩'),
    }),
    'short-dungeon': Object.freeze({
      id: 'short-dungeon', kind: 'short', label: '地下城壁龛', icon: '🏮',
      subtitle: '安全壁龛，包扎补给', effect: 'torchlight',
      image: imageUrl('短休-地下城.jpg'),
      audio: audioUrl('短休·壁龛微灯'),
    }),
    'long-outdoor': Object.freeze({
      id: 'long-outdoor', kind: 'long', label: '室外星夜', icon: '🌙',
      subtitle: '星夜安营，静候黎明', effect: 'stars',
      image: imageUrl('长休-室外星夜.jpg'),
      audio: audioUrl('长休·星夜至晨'),
    }),
    'long-indoor': Object.freeze({
      id: 'long-indoor', kind: 'long', label: '室内旅店', icon: '🛏️',
      subtitle: '雨落旅店，一夜安眠', effect: 'rain',
      image: imageUrl('长休-室内旅店.jpg'),
      audio: audioUrl('长休·雨窗安眠'),
    }),
    'long-shelter': Object.freeze({
      id: 'long-shelter', kind: 'long', label: '风雪避难所', icon: '❄️',
      subtitle: '风雪在外，洞火守夜', effect: 'snow',
      image: imageUrl('长休-风雪避难.jpg'),
      audio: audioUrl('长休·雪外余温'),
    }),
  });

  const BY_KIND = Object.freeze({
    short: Object.freeze(['short-outdoor', 'short-indoor', 'short-dungeon']),
    long: Object.freeze(['long-outdoor', 'long-indoor', 'long-shelter']),
  });

  function get(sceneId, kind) {
    const normalizedKind = kind === 'long' ? 'long' : 'short';
    const scene = SCENES[String(sceneId || '')];
    return scene && scene.kind === normalizedKind ? scene : SCENES[BY_KIND[normalizedKind][0]];
  }

  function pick(kind) {
    const normalizedKind = kind === 'long' ? 'long' : 'short';
    const choices = BY_KIND[normalizedKind];
    return SCENES[choices[Math.floor(Math.random() * choices.length)]];
  }

  function preload() {
    Object.values(SCENES).forEach((scene) => {
      const image = new Image();
      image.decoding = 'async';
      image.src = scene.image;
    });
  }

  global.SundollRestScenes = Object.freeze({ SCENES, BY_KIND, get, pick, preload });
  // Display assets load when a rest is requested, not while joining a room.
})(window);
