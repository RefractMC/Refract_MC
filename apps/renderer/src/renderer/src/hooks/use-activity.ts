import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'

const queryKey = ['activity']

export function useActivity() {
  return useQuery({ queryKey, queryFn: () => api.activity.list() })
}

export function useRecordActivity() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (label: string) => api.activity.add(label),
    onMutate: () => queryClient.cancelQueries({ queryKey }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  })
}
