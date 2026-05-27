/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/web/**/*.{ts,tsx,html}"],
  theme: {
    extend: {
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};
