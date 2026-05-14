<script setup>
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { login } from '../utils/auth'

/*
  Login View Responsibilities
  - Supports both sign-in and account registration in one UI flow.
  - Redirects users back to protected pages via the redirect query parameter.
  - Sends auth requests to /api/scoreboard?action=auth and persists safe user profile data locally.
  - Provides explicit validation and user-friendly error/success feedback states.
*/

const route = useRoute()
const router = useRouter()
const mode = ref('login')
const username = ref('')
const password = ref('')
const registerName = ref('')
const registerEmail = ref('')
const registerPassword = ref('')
const registerPostcode = ref('')
const loading = ref(false)
const error = ref('')
const success = ref('')
const redirectTarget = computed(() =>
  typeof route.query.redirect === 'string' ? route.query.redirect : '/',
)

// Protected-page login copy follows the redirect target so the access screen matches the page the user clicked.
const protectedPageCopy = computed(() => {
  const target = redirectTarget.value
  if (target.startsWith('/impact-score')) {
    return {
      title: 'Sign in to view Impact Score',
      subtitle: 'Continue your impact score',
    }
  }
  if (
    target.startsWith('/cat-scoreboard') ||
    target.startsWith('/my-dashboard') ||
    target.startsWith('/dashboard') ||
    target.startsWith('/guardian/leaderboard')
  ) {
    return {
      title: 'Sign in to view Scoreboard',
      subtitle: 'Continue your scoreboard',
    }
  }
  if (target.startsWith('/hunter-profile')) {
    return {
      title: 'Sign in to view Hunter Profile',
      subtitle: "Continue to your cat's Hunter Profile",
    }
  }
  if (target.startsWith('/wildlife-intelligence')) {
    return {
      title: 'Sign in to view Wildlife Intelligence',
      subtitle: 'Continue to Community Wildlife Intelligence',
    }
  }

  return {
    title: 'Sign in to Catwatcher',
    subtitle: 'Use your team account to access protected Catwatcher pages.',
  }
})

const heroTitle = computed(() => protectedPageCopy.value.title)
const heroSubtitle = computed(() => protectedPageCopy.value.subtitle)

const switchMode = (nextMode) => {
  mode.value = nextMode
  error.value = ''
  success.value = ''
}

const readJsonResponse = async (response) => {
  try {
    return await response.json()
  } catch {
    return {}
  }
}

// Send login/register requests through the real database auth API.
const postAuth = async (body) => {
  let response = null
  let payload = null

  try {
    response = await fetch('/api/scoreboard?action=auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    payload = await readJsonResponse(response)
  } catch (err) {
    throw new Error(
      err?.message
        ? `Unable to reach the database auth API: ${err.message}`
        : 'Unable to reach the database auth API.',
    )
  }

  if (!response.ok) {
    throw new Error(payload?.error || `Authentication failed with status ${response.status}.`)
  }

  return payload
}

// Log in and save the returned user profile in the browser session.
const handleLogin = async () => {
  error.value = ''
  success.value = ''
  if (!username.value.trim() || !password.value.trim()) {
    error.value = 'Please enter your email and password.'
    return
  }

  loading.value = true
  try {
    const payload = await postAuth({
      action: 'login',
      email: username.value,
      password: password.value,
    })
    login(payload.user)
    const redirectTo = typeof route.query.redirect === 'string' ? route.query.redirect : '/'
    await router.replace(redirectTo)
  } catch (err) {
    error.value = err?.message || 'Unable to sign in right now. Please try again later.'
  } finally {
    loading.value = false
  }
}

// Register a new database account, then require a normal login before continuing.
const handleRegister = async () => {
  error.value = ''
  success.value = ''
  if (
    !registerName.value.trim() ||
    !registerEmail.value.trim() ||
    !registerPassword.value.trim() ||
    !registerPostcode.value.trim()
  ) {
    error.value = 'Please enter your name, email, password, and postcode.'
    return
  }
  if (!/^\d{4}$/.test(registerPostcode.value.trim())) {
    error.value = 'Please enter a 4-digit Victorian postcode.'
    return
  }

  loading.value = true
  try {
    await postAuth({
      action: 'register',
      name: registerName.value,
      email: registerEmail.value,
      password: registerPassword.value,
      postcode: registerPostcode.value,
    })
    username.value = registerEmail.value.trim()
    password.value = ''
    registerName.value = ''
    registerEmail.value = ''
    registerPassword.value = ''
    registerPostcode.value = ''
    mode.value = 'login'
    success.value = 'Account created. Please sign in to continue.'
  } catch (err) {
    error.value = err?.message || 'Unable to create account right now. Please try again later.'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <main class="login-page">
    <section class="login-panel">
      <article class="login-hero">
        <div class="hero-logo-wrap" aria-hidden="true">
          <img class="hero-logo" src="/images/catwatch-logo.jpg" alt="" />
        </div>
        <p class="eyebrow">Catwatcher Secure Access</p>
        <h1>{{ heroTitle }}</h1>
        <p>{{ heroSubtitle }}</p>
      </article>

      <article class="login-form-wrap">
        <h2>{{ mode === 'login' ? 'Login' : 'Create Account' }}</h2>

        <form v-if="mode === 'login'" class="login-form" @submit.prevent="handleLogin">
          <label>
            <span>Email Address</span>
            <input v-model="username" type="email" autocomplete="username" placeholder="Enter your email" />
          </label>
          <label>
            <span>Password</span>
            <input v-model="password" type="password" autocomplete="current-password" placeholder="Enter password" />
          </label>
          <button type="submit" :disabled="loading">
            {{ loading ? 'Signing in...' : 'Sign In' }}
          </button>
        </form>

        <form v-else class="login-form" @submit.prevent="handleRegister">
          <label>
            <span>Full Name</span>
            <input v-model="registerName" type="text" autocomplete="name" placeholder="Enter your name" />
          </label>
          <label>
            <span>Email Address</span>
            <input v-model="registerEmail" type="email" autocomplete="email" placeholder="Enter your email" />
          </label>
          <label>
            <span>Password</span>
            <input
              v-model="registerPassword"
              type="password"
              autocomplete="new-password"
              placeholder="Enter your password"
            />
          </label>
          <label>
            <span>Postcode</span>
            <input v-model="registerPostcode" inputmode="numeric" placeholder="e.g., 3168" />
          </label>
          <button type="submit" :disabled="loading">
            {{ loading ? 'Creating...' : 'Create Account' }}
          </button>
        </form>

        <button v-if="mode === 'login'" type="button" class="mode-link" @click="switchMode('register')">
          Don't have an account? Sign up
        </button>
        <button v-else type="button" class="mode-link" @click="switchMode('login')">
          Already have an account? Sign in
        </button>
        <p v-if="error" class="error">{{ error }}</p>
        <p v-if="success" class="success">{{ success }}</p>
      </article>
    </section>
  </main>
</template>

<style scoped>
.login-page {
  min-height: calc(100dvh - 101px);
  background:
    radial-gradient(circle at 20% 15%, #c6f6d5 0%, transparent 45%),
    radial-gradient(circle at 80% 25%, #bae6fd 0%, transparent 40%),
    linear-gradient(140deg, #f6faf7 0%, #eef5f0 100%);
  padding: 24px 16px;
  display: grid;
  place-items: center;
}

.login-panel {
  width: 100%;
  max-width: 760px;
  margin: 0 auto;
  border: 1px solid #d9e2db;
  border-radius: 18px;
  background: #ffffff;
  box-shadow: 0 18px 46px rgba(21, 64, 43, 0.11);
  overflow: hidden;
  display: block;
}

.login-hero {
  padding: 36px 32px 26px;
  background: linear-gradient(150deg, #12452d 0%, #0f5a37 58%, #0f766e 100%);
  color: #effaf3;
  text-align: center;
  display: grid;
  justify-items: center;
}

.hero-logo-wrap {
  width: 96px;
  height: 96px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.2);
  border: 1px solid rgba(255, 255, 255, 0.3);
  display: grid;
  place-items: center;
}

.hero-logo {
  width: 62px;
  height: 62px;
  object-fit: cover;
  border-radius: 14px;
}

.eyebrow {
  display: inline-flex;
  padding: 6px 12px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.16);
  border: 1px solid rgba(255, 255, 255, 0.28);
  font-size: 0.8rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  font-weight: 800;
}

.login-hero h1 {
  margin-top: 16px;
  font-size: 2rem;
  line-height: 1.2;
}

.login-hero p {
  margin-top: 14px;
  color: #d5efe0;
  max-width: 560px;
}

.login-form-wrap {
  padding: 30px 32px 34px;
  max-width: 540px;
  margin: 0 auto;
}

.login-form-wrap h2 {
  margin: 0;
  color: #1f3c2f;
  font-size: 1.6rem;
}

.login-form {
  margin-top: 18px;
  display: grid;
  gap: 14px;
}

.login-form label {
  display: grid;
  gap: 7px;
}

.login-form span {
  color: #466454;
  font-weight: 700;
}

.login-form input {
  height: 48px;
  border-radius: 10px;
  border: 1px solid #cfe0d5;
  padding: 0 14px;
  font: inherit;
}

.login-form input:focus {
  outline: none;
  border-color: #1f7a4d;
  box-shadow: 0 0 0 3px rgba(31, 122, 77, 0.15);
}

.login-form button {
  margin-top: 8px;
  height: 48px;
  border: 0;
  border-radius: 10px;
  background: linear-gradient(90deg, #1e7a4c, #0f766e);
  color: #fff;
  font-weight: 800;
  font-size: 1rem;
  cursor: pointer;
}

.mode-link {
  display: block;
  width: 100%;
  margin: 20px 0 0;
  border: 0;
  background: transparent;
  color: #059669;
  font: inherit;
  font-weight: 800;
  cursor: pointer;
}

.login-form button:disabled {
  cursor: wait;
  opacity: 0.75;
}

.error,
.success {
  margin-top: 12px;
  border-radius: 10px;
  padding: 10px 12px;
  font-weight: 700;
}

.error {
  border: 1px solid #fecaca;
  background: #fff1f2;
  color: #b91c1c;
}

.success {
  border: 1px solid #bbf7d0;
  background: #f0fdf4;
  color: #166534;
}

@media (max-width: 960px) {
  .login-hero {
    padding: 28px 24px;
  }

  .hero-logo-wrap {
    width: 84px;
    height: 84px;
  }

  .hero-logo {
    width: 54px;
    height: 54px;
  }

  .login-form-wrap {
    padding: 28px 24px;
  }
}
</style>
