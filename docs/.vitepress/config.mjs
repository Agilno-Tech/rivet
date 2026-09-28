import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'Rivet',
  description: 'A shared development workflow for teams and their coding agents.',
  base: process.env.RIVET_DOCS_BASE || '/',
  srcDir: 'site',
  cleanUrls: false,
  themeConfig: {
    socialLinks: [{ icon: 'github', link: 'https://github.com/Agilno-Tech/rivet' }],
    editLink: { pattern: 'https://github.com/Agilno-Tech/rivet/edit/main/docs/site/:path' },
    search: { provider: 'local' },
    nav: [
      { text: 'Get started', link: '/getting-started' },
      { text: 'Reference', link: '/runtime-reference' },
      { text: 'Help', link: '/troubleshooting' },
    ],
    sidebar: [
      { text: 'Start here', items: [
        { text: 'Overview', link: '/' },
        { text: 'Get started', link: '/getting-started' },
        { text: 'Installation', link: '/installation' },
        { text: 'Compatibility', link: '/compatibility' },
      ] },
      { text: 'Use Rivet', items: [
        { text: 'Task status and recovery', link: '/statuses' },
        { text: 'Project protocols', link: '/memory-and-protocols' },
        { text: 'Integrations', link: '/integrations' },
        { text: 'Models and harnesses', link: '/models' },
        { text: 'Repository inspection', link: '/repositories' },
        { text: 'Review and delivery', link: '/delivery' },
      ] },
      { text: 'Reference and help', items: [
        { text: 'Configuration and commands', link: '/runtime-reference' },
        { text: 'Architecture', link: '/architecture' },
        { text: 'Capabilities and limitations', link: '/status' },
        { text: 'Troubleshooting', link: '/troubleshooting' },
        { text: 'Versions and updates', link: '/release' },
        { text: 'Contributing', link: '/contributing' },
      ] },
    ],
  },
});
