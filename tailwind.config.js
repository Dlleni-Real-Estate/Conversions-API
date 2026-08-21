/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      boxShadow: {
        // A card has to have an edge. On a light page a hairline border alone
        // reads as nothing — this is the difference between "sections" and
        // "one flat sheet of white".
        card: "0 1px 2px rgba(15,23,42,0.06), 0 1px 3px rgba(15,23,42,0.04)",
        panel: "0 10px 30px rgba(15,23,42,0.10), 0 2px 8px rgba(15,23,42,0.06)",
      },
    },
  },
  plugins: [],
};
