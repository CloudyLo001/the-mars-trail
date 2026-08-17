import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // One worker: parallel headless WebGL contexts share the software
  // rasterizer, and the frame-time collapse makes game time drift from wall
  // time, flaking timed gameplay phases and screenshot baselines.
  workers: 1,
  // WebGL under a software rasterizer is slow, and every spec boots a fresh
  // GL context plus the asset load. 30s was tight enough to fail on teardown
  // rather than on any real assertion.
  timeout: 90_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: 'http://127.0.0.1:5188',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5188',
    reuseExistingServer: true,
    timeout: 20_000,
  },
  projects: [
    {
      name: 'desktop-chrome',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 720 },
      },
    },
    {
      name: 'mobile-safari',
      use: {
        ...devices['iPhone 13'],
      },
    },
  ],
});
