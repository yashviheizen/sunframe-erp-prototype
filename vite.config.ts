import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
// Relative base: the app uses hash routing, so the same build works at the site root and under
// a sub-path such as GitHub Pages (https://<user>.github.io/sunframe-erp-prototype/).
export default defineConfig({
  base: './',
  plugins: [react()],
})
