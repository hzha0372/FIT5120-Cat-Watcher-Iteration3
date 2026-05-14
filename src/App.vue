<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { AUTH_CHANGED_EVENT, isAuthenticated, logout } from './utils/auth'

/*
  App Shell Responsibilities
  - Renders the global header/navigation that wraps every page in the app.
  - Syncs auth state with storage/custom events so Login/Logout state is always accurate.
  - Controls Explore menu open/close behavior and active link highlighting.
  - Handles logout redirects when the current route requires authentication.
*/

// Track logo loading so the header remains clean if the image asset is unavailable.
const logoMissing = ref(false)
const route = useRoute()
const router = useRouter()
const exploreOpen = ref(false)
const authRevision = ref(0)

// Define Explore dropdown links and active route matching.
const exploreItems = [
  {
    label: 'Risk Map',
    to: '/risk-map',
    match: (path) => path.startsWith('/risk-map'),
  },
  {
    label: 'Impact Score',
    to: '/impact-score',
    match: (path) => path.startsWith('/impact-score'),
  },
  {
    label: 'Scoreboard',
    to: '/cat-scoreboard',
    match: (path) =>
      path.startsWith('/cat-scoreboard') ||
      path.startsWith('/my-dashboard') ||
      path.startsWith('/dashboard'),
  },
  {
    label: 'Photo Identifier',
    to: '/photo-identifier',
    match: (path) => path.startsWith('/photo-identifier') || path.startsWith('/sighting-reporter'),
  },
  {
    label: 'Hunter Profile',
    to: '/hunter-profile',
    match: (path) => path.startsWith('/hunter-profile'),
  },
  {
    label: 'Wildlife Intelligence',
    to: '/wildlife-intelligence',
    match: (path) => path.startsWith('/wildlife-intelligence'),
  },
  {
    label: 'About Us',
    to: '/about',
    match: (path) => path.startsWith('/about') || path.startsWith('/vision-mission'),
  },
]

const exploreActive = computed(() => exploreItems.some((item) => item.match(route.path)))
const isExploreItemActive = (item) => item.match(route.path)
const authed = computed(() => {
  authRevision.value
  return isAuthenticated()
})

const refreshAuthState = () => {
  authRevision.value += 1
}

const handleLogout = async () => {
  logout()
  if (route.meta.requiresAuth) {
    await router.push({
      path: '/login',
      query: { redirect: route.fullPath },
    })
  }
}

// Close the dropdown after navigation.
watch(
  () => route.fullPath,
  () => {
    exploreOpen.value = false
    refreshAuthState()
  },
)

onMounted(() => {
  window.addEventListener(AUTH_CHANGED_EVENT, refreshAuthState)
  window.addEventListener('storage', refreshAuthState)
})

onUnmounted(() => {
  window.removeEventListener(AUTH_CHANGED_EVENT, refreshAuthState)
  window.removeEventListener('storage', refreshAuthState)
})
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <div class="header-inner">
        <div class="brand">
          <img
            v-if="!logoMissing"
            src="/images/catwatch-logo.jpg"
            alt="Catwatcher logo"
            @error="logoMissing = true"
          />
          <div class="brand-text">
            <h1>CATWATCHER</h1>
            <p>Protecting Wildlife, Responsible Pet Ownership</p>
          </div>
        </div>
        <!-- Shared navigation stays outside individual views so every feature keeps one shell. -->
        <nav class="top-nav">
          <RouterLink to="/" class="nav-pill" :class="{ active: route.path === '/' }">
            Home
          </RouterLink>
          <div
            class="explore-nav"
            :class="{ open: exploreOpen, active: exploreActive }"
            @mouseenter="exploreOpen = true"
            @mouseleave="exploreOpen = false"
          >
            <!-- The button supports both hover and click. -->
            <button
              class="nav-pill explore-trigger"
              type="button"
              :aria-expanded="exploreOpen"
              aria-haspopup="true"
              @click="exploreOpen = !exploreOpen"
            >
              <span>Explore</span>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
            <div class="explore-menu" role="menu">
              <RouterLink
                v-for="item in exploreItems"
                :key="item.to"
                class="explore-item"
                :class="{ active: isExploreItemActive(item) }"
                :to="item.to"
                role="menuitem"
                @click="exploreOpen = false"
              >
                {{ item.label }}
              </RouterLink>
            </div>
          </div>
          <button v-if="authed" type="button" class="nav-pill login-pill" @click="handleLogout">
            Logout
          </button>
          <RouterLink v-else to="/login" class="nav-pill login-pill" :class="{ active: route.path === '/login' }">
            Login
          </RouterLink>
        </nav>
      </div>
    </header>

    <router-view />
  </div>
</template>

<style scoped>
.app-shell {
  min-height: 100dvh;
  background: #f1f3f0;
  overflow-x: clip;
}

.app-header {
  position: sticky;
  top: 0;
  z-index: 900;
  border-bottom: 1px solid #d5dbd4;
  background: rgba(249, 250, 248, 0.96);
  backdrop-filter: blur(6px);
}

.header-inner {
  width: 100%;
  max-width: 1320px;
  margin: 0 auto;
  padding: 14px 16px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 20px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 18px;
}

.brand img {
  width: 96px;
  height: 96px;
  border-radius: 14px;
  object-fit: cover;
  border: 1px solid #c5cec3;
}

.brand-text h1 {
  font-size: 2.1rem;
  line-height: 1.1;
  font-weight: 800;
  color: #133a29;
}

.brand-text p {
  margin-top: 4px;
  color: #557061;
  font-size: 1.02rem;
  font-weight: 700;
}

.top-nav {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  justify-content: flex-end;
  margin-right: 80px;
}

.nav-pill {
  display: inline-flex;
  min-height: 56px;
  align-items: center;
  justify-content: center;
  gap: 9px;
  text-decoration: none;
  font-weight: 700;
  font-size: 1.3rem;
  color: #3d5d4f;
  border: 1px solid transparent;
  border-radius: 999px;
  padding: 0 22px;
  background: transparent;
  cursor: pointer;
  font-family: inherit;
}

.nav-pill:hover {
  border-color: #bfd0c1;
  background: #ecf2ec;
}

.nav-pill.active {
  color: #17462f;
  border-color: #a9c8af;
  background: #e5f1e7;
  box-shadow: none;
}

.explore-nav {
  position: relative;
}

/* Invisible hover bridge between the pill and dropdown. */
.explore-nav::after {
  position: absolute;
  top: 100%;
  left: -18px;
  right: -18px;
  height: 14px;
  content: '';
}

.explore-trigger {
  color: #3d5d4f;
  font-size: 1.3rem;
  font-weight: 700;
  background: transparent;
}

.explore-nav.active .explore-trigger,
.explore-nav.open .explore-trigger {
  color: #17462f;
  border-color: #a9c8af;
  background: #e5f1e7;
}

.explore-trigger svg {
  width: 21px;
  height: 21px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2.5;
  stroke-linecap: round;
  stroke-linejoin: round;
  transition: transform 160ms ease;
}

.explore-nav.open .explore-trigger svg {
  transform: rotate(180deg);
}

.explore-menu {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  min-width: 340px;
  border: 2px solid #e5e7eb;
  border-radius: 18px;
  background: #ffffff;
  box-shadow: 0 18px 36px rgba(15, 23, 42, 0.12);
  padding: 18px 0;
  opacity: 0;
  pointer-events: none;
  transform: translateY(-6px);
  transition:
    opacity 160ms ease,
    transform 160ms ease;
}

.explore-nav.open .explore-menu {
  opacity: 1;
  pointer-events: auto;
  transform: translateY(0);
}

.explore-item {
  display: block;
  color: #374151;
  text-decoration: none;
  font-size: 1.18rem;
  font-weight: 700;
  line-height: 1.2;
  padding: 18px 22px;
  text-align: left;
  white-space: nowrap;
}

.explore-item:hover,
.explore-item.active {
  color: #047857;
  background: #e8f8ef;
}

@media (max-width: 960px) {
  .header-inner {
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
  }

  .top-nav {
    width: 100%;
    justify-content: flex-start;
    margin-right: 0;
  }
}

@media (max-width: 640px) {
  .brand img {
    width: 64px;
    height: 64px;
    border-radius: 12px;
  }

  .brand-text h1 {
    font-size: 1.45rem;
  }

  .brand-text p {
    display: block;
    font-size: 0.75rem;
  }

  .nav-pill {
    min-height: 48px;
    font-size: 1.05rem;
    padding: 0 14px;
  }

  .explore-menu {
    left: auto;
    right: 0;
    min-width: min(292px, calc(100vw - 32px));
  }

  .explore-item {
    font-size: 1.08rem;
    padding: 16px 26px;
  }
}
</style>
