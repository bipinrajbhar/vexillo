import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { router } from './router'
import { DashboardApiProvider } from './domain/dashboard-api/provider'
import { createFetchDashboardApi } from './domain/dashboard-api/fetch-adapter'
import './globals.css'

const queryClient = new QueryClient()
const dashboardApi = createFetchDashboardApi()

const root = document.getElementById('root')!
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <DashboardApiProvider value={dashboardApi}>
        <RouterProvider router={router} />
      </DashboardApiProvider>
    </QueryClientProvider>
  </StrictMode>,
)
