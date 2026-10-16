/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      fontFamily: {
        // Chinese: PingFang SC on macOS (what the system picked anyway), Microsoft
        // YaHei on Windows, where Han text in an lang="en" page otherwise falls
        // back to a Japanese face.
        sans: ['"Plus Jakarta Sans"', '"PingFang SC"', '"Microsoft YaHei UI"', '"Microsoft YaHei"', "system-ui", "sans-serif"],
      },
      colors: {
        app: "rgb(var(--app-bg) / <alpha-value>)",
        chrome: "rgb(var(--chrome-bg) / <alpha-value>)",
        sidebar: "rgb(var(--sidebar-bg) / <alpha-value>)",
        panel: "rgb(var(--panel-bg) / <alpha-value>)",
        panel2: "rgb(var(--panel-bg-2) / <alpha-value>)",
        hover: "rgb(var(--hover-bg) / <alpha-value>)",
        selected: "rgb(var(--selected-bg) / <alpha-value>)",
        border: "rgb(var(--border-color) / <alpha-value>)",
        muted: "rgb(var(--muted-text) / <alpha-value>)",
        muted2: "rgb(var(--muted-text-2) / <alpha-value>)",
        text: "rgb(var(--text-color) / <alpha-value>)",
        accent: "rgb(var(--accent-color) / <alpha-value>)",
        accentSoft: "rgb(var(--accent-soft) / <alpha-value>)",
        accentInk: "rgb(var(--accent-ink) / <alpha-value>)",
        glow: "rgb(var(--glow-accent) / <alpha-value>)",
        success: "rgb(var(--success-color) / <alpha-value>)",
        warn: "rgb(var(--warn-color) / <alpha-value>)",
        error: "rgb(var(--error-color) / <alpha-value>)",
      },
      boxShadow: {
        overlay: "var(--shadow-overlay)",
        menu: "var(--shadow-menu)",
        glow: "0 0 0 2.5px rgb(var(--accent-color))",
        "card-hover": "none",
      },
      // 圆角按高度定:≤24 高的控件 `rounded` 6 / 25–34 高的按钮、列表行、菜单行 `rounded-md` 8 /
      // 照片格、缩略图 `rounded-app` 10 / 菜单与弹层 `rounded-lg` 14 / 大面板 `rounded-xl` 18。
      // 胶囊(999)只给工具栏、筛选芯片和主 / 次 CTA。字段(输入 / 下拉 / 数值框)在 src/ui/fields.jsx 写死 6 / 8。
      borderRadius: {
        sm: "4px",
        DEFAULT: "6px",
        md: "8px",
        lg: "14px",
        xl: "18px",
        "2xl": "22px",
        app: "10px",
      },
      gridTemplateColumns: {
        app: "var(--sidebar-width, 240px) minmax(0, 1fr) var(--inspector-width, 300px)",
      },
    },
  },
  plugins: [],
};
