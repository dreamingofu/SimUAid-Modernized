// Central palette + a few layout constants shared by the renderer.

export const COLORS = {
  background: '#ffffff',
  gate: '#1f1f1f',
  pin: '#1f1f1f',
  pinDot: '#1f1f1f',
  pinLabel: '#000000',
  deviceLabel: '#d12b2b',
  wire: '#1f1f1f',
  junction: '#1f1f1f',
  selection: '#2d6cdf',
  highlight: '#d12b2b',
  grid: '#e6e6e6',
  page: '#e0a3a3',
  value: '#1a7f37'
} as const

export const FONTS = {
  pinName: '10px "Segoe UI", system-ui, sans-serif',
  deviceLabel: '13px "Segoe UI", system-ui, sans-serif',
  value: 'bold 11px "Segoe UI", system-ui, sans-serif',
  ffPin: '9px "Segoe UI", system-ui, sans-serif'
} as const
