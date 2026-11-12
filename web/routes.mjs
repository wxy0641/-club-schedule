// 路由是纯函数：hash 路径、页面归属、返回目标与登录后合法目标都不接触 DOM。
export const SPACE_PAGES = ['home', 'schedule', 'calendar', 'collect', 'settings', 'legacy'];

export const PAGE_LABELS = {
  spaces: '我的空间',
  create: '创建空间',
  join: '邀请加入',
  home: '空间首页',
  schedule: '我的课表',
  calendar: '我的日历',
  collect: '课表收集',
  settings: '空间设置',
  legacy: '旧版空间',
  notfound: '页面不存在',
};

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function normalizePath(raw) {
  let value = typeof raw === 'string' ? raw : '';
  if (value.startsWith('#')) value = value.slice(1);
  if (!value.startsWith('/')) value = `/${value}`;
  value = value.replace(/\/{2,}/g, '/');
  if (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1);
  return value || '/spaces';
}

export function routePath(name, spaceId = null) {
  if (name === 'spaces') return '/spaces';
  if (name === 'create') return '/spaces/new';
  if (name === 'join') return '/spaces/join';
  if (name === 'notfound') return '/notfound';
  if (!spaceId) return '/spaces';
  if (name === 'home') return `/spaces/${spaceId}`;
  return `/spaces/${spaceId}/${name}`;
}

export function parseRoute(raw) {
  const path = normalizePath(raw);
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return { name: 'spaces', path: '/spaces', spaceId: null };
  if (parts[0] !== 'spaces') return { name: 'notfound', path: '/notfound', spaceId: null };
  if (parts.length === 1) return { name: 'spaces', path: '/spaces', spaceId: null };
  if (parts.length === 2 && parts[1] === 'new') {
    return { name: 'create', path: '/spaces/new', spaceId: null };
  }
  if (parts.length === 2 && parts[1] === 'join') {
    return { name: 'join', path: '/spaces/join', spaceId: null };
  }
  if (!isUuid(parts[1])) return { name: 'notfound', path: '/notfound', spaceId: null };
  const spaceId = parts[1];
  if (parts.length === 2) return { name: 'home', path: routePath('home', spaceId), spaceId };
  if (parts.length !== 3 || !SPACE_PAGES.includes(parts[2])) {
    return { name: 'notfound', path: '/notfound', spaceId: null };
  }
  return {
    name: parts[2],
    path: routePath(parts[2], spaceId),
    spaceId,
  };
}

export function parentRoute(route) {
  if (!route || route.name === 'spaces' || route.name === 'notfound') {
    return parseRoute('/spaces');
  }
  if (route.name === 'create' || route.name === 'join') {
    return parseRoute('/spaces');
  }
  if (route.name === 'home' || !route.spaceId) {
    return parseRoute('/spaces');
  }
  return parseRoute(`/spaces/${route.spaceId}`);
}

export function isSpacePage(name) {
  return SPACE_PAGES.includes(name);
}

// 登录只恢复仍合法的目标：未知路径、不存在的空间一律回到“我的空间”；
// 成员身份和页面角色在加载空间首页后再次校验，不在 URL 阶段缓存任何他人数据。
export function resolveLoginTarget(raw, spaces) {
  const route = parseRoute(raw);
  if (route.name === 'notfound') return '/spaces';
  if (route.spaceId && !Array.isArray(spaces)) return '/spaces';
  if (route.spaceId && !spaces.some((space) => space.id === route.spaceId)) return '/spaces';
  return route.path;
}

export function collectVisible(role) {
  return role === 'owner';
}
