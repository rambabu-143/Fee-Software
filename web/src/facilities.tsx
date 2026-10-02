import { Form, Modal, Select, message } from 'antd'
import { useEffect, useState } from 'react'
import { api } from './api'

type Facility = { id: number; name: string }
type Assignment = { kind: 'TRANSPORT' | 'HOSTEL'; facilityId: number; name: string }

// Which transport route and hostel room a student is on, for the selected year.
// Two independent PUTs (one per kind); omitting facilityId clears that kind.
export function FacilitiesModal({ student, schoolId, yearId, onClose }: {
  student: { id: number; name: string } | null; schoolId?: number; yearId?: number; onClose: () => void
}) {
  const [form] = Form.useForm()
  const [routes, setRoutes] = useState<Facility[]>([])
  const [rooms, setRooms] = useState<Facility[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!student || !schoolId) return
    form.resetFields()
    Promise.all([
      api<Facility[]>(`/facilities?schoolId=${schoolId}&kind=TRANSPORT`),
      api<Facility[]>(`/facilities?schoolId=${schoolId}&kind=HOSTEL`),
      api<Assignment[]>(`/students/${student.id}/facilities?yearId=${yearId}`),
    ]).then(([routeOptions, roomOptions, current]) => {
      setRoutes(routeOptions)
      setRooms(roomOptions)
      form.setFieldsValue({
        routeId: current.find((a) => a.kind === 'TRANSPORT')?.facilityId,
        roomId: current.find((a) => a.kind === 'HOSTEL')?.facilityId,
      })
    }).catch((e) => message.error(e.message))
  }, [student, schoolId, yearId])

  async function save({ routeId, roomId }: { routeId?: number; roomId?: number }) {
    setSaving(true)
    try {
      await Promise.all([
        api(`/students/${student!.id}/facilities`, { method: 'PUT', body: JSON.stringify({ yearId, kind: 'TRANSPORT', facilityId: routeId }) }),
        api(`/students/${student!.id}/facilities`, { method: 'PUT', body: JSON.stringify({ yearId, kind: 'HOSTEL', facilityId: roomId }) }),
      ])
      message.success('Transport & hostel saved')
      onClose()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={student && `Transport & hostel · ${student.name}`} open={!!student} onCancel={onClose} onOk={form.submit} okText="Save" confirmLoading={saving}>
      <Form form={form} layout="vertical" onFinish={save}>
        <Form.Item name="routeId" label="Transport route">
          <Select allowClear placeholder="None" options={routes.map((r) => ({ value: r.id, label: r.name }))} />
        </Form.Item>
        <Form.Item name="roomId" label="Hostel room">
          <Select allowClear placeholder="None" options={rooms.map((r) => ({ value: r.id, label: r.name }))} />
        </Form.Item>
      </Form>
    </Modal>
  )
}
