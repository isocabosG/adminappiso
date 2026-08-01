import React from 'react'
import { createRoot } from 'react-dom/client'
import Root from './Root.jsx'
import { installSupabaseStorage } from './storageShim.js'

installSupabaseStorage()
createRoot(document.getElementById('root')).render(<Root />)
