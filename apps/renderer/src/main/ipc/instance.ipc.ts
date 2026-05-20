import {
  listInstances,
  getInstanceById,
  createAndSaveInstance,
  updateInstance,
  deleteInstance,
} from '../services/instance-store'
import type { CreateInstanceInput, Instance } from '@refract/core'
import { handleIpc } from './handle'

export function registerInstanceIpc(): void {
  handleIpc('instance.list', () => listInstances())

  handleIpc('instance.getById', (_event, id) => getInstanceById(String(id)))

  handleIpc('instance.create', (_event, input) =>
    createAndSaveInstance(input as CreateInstanceInput)
  )

  handleIpc(
    'instance.update',
    (_event, id, patch) =>
      updateInstance(String(id), patch as Partial<Omit<Instance, 'id' | 'createdAt'>>)
  )

  handleIpc(
    'instance.delete',
    (_event, id, deleteFiles) => {
      deleteInstance(String(id), Boolean(deleteFiles))
    }
  )
}
