import { api } from '@/lib/api-client'
import type { DashboardApi } from './port'

export const createFetchDashboardApi = (): DashboardApi => api
