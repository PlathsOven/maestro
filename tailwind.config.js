/** @type {import('tailwindcss').Config} */
module.exports = {
  presets: [require('./src/shared/ui/tailwind.preset.cjs')],
  content: ['./index.html', './src/renderer/**/*.{ts,tsx,html}', './src/shared/ui/**/*.{ts,tsx}'],
  darkMode: 'class',
};
