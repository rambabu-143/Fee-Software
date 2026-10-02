import { Form, Modal, Select, message } from 'antd'
import { useEffect, useState } from 'react'
import { api } from './api'

type Facility = { id: number; name: string }
type Stop = { id: number; name: string; route: string }
type StopInfo = { id: number } | null
type Assignment = { kind: 'TRANSPORT' | 'HOSTEL'; facilityId: number; name: string }

// Which transport route and hostel room a student is on, for the selected year.
// Two independent PUTs (one per kind); omitting facilityId clears that kind.
export function FacilitiesModal({ student, schoolId, yearId, onClose }: {
  student: { id: number; name: string } | null; schoolId?: number; yearId?: number; onClose: () => void
}) {
  const [form] = Form.useForm()
  const [routes, setRoutes] = useState<Facility[]>([])
  const [rooms, setRooms] = useState<Facility[]>([])
  const [stops, setStops] = useState<Stop[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!student || !schoolId) return
    form.resetFields()
    Promise.all([
      api<Facility[]>(`/facilities?schoolId=${schoolId}&kind=TRANSPORT`),
      api<Facility[]>(`/facilities?schoolId=${schoolId}&kind=HOSTEL`),
      api<Assignment[]>(`/students/${student.id}/facilities?yearId=${yearId}`),
      api<Stop[]>(`/stops?schoolId=${schoolId}`),
      api<{ pickup: StopInfo; drop: StopInfo }>(`/students/${student.id}/transport?yearId=${yearId}`),
    ]).then(([routeOptions, roomOptions, current, stopOptions, trip]) => {
      setRoutes(routeOptions)
      setRooms(roomOptions)
      setStops(stopOptions)
      form.setFieldsValue({
        routeId: current.find((a) => a.kind === 'TRANSPORT')?.facilityId,
        roomId: current.find((a) => a.kind === 'HOSTEL')?.facilityId,
        pickupStopId: trip.pickup?.id,
        dropStopId: trip.drop?.id,
      })
    }).catch((e) => message.error(e.message))
  }, [student, schoolId, yearId])

  async function save({ routeId, roomId, pickupStopId, dropStopId }: { routeId?: number; roomId?: number; pickupStopId?: number; dropStopId?: number }) {
    if (routeId && (pickupStopId || dropStopId)) return message.error('Choose either a flat-fee route or bus stops, not both')
    const put = (path: string, body: object) => api(`/students/${student!.id}/${path}`, { method: 'PUT', body: JSON.stringify({ yearId, ...body }) })
    setSaving(true)
    try {
      // The server refuses a student on both a flat route and stops, so clear one before setting the other.
      if (routeId) {
        await put('transport', {})
        await put('facilities', { kind: 'TRANSPORT', facilityId: routeId })
      } else {
        await put('facilities', { kind: 'TRANSPORT' })
        await put('transport', { pickupStopId: pickupStopId ?? null, dropStopId: dropStopId ?? null })
      }
      await put('facilities', { kind: 'HOSTEL', facilityId: roomId })
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
        <Form.Item name="pickupStopId" label="Morning pickup stop (half the slab fare)">
          <Select allowClear showSearch optionFilterProp="label" placeholder="None" options={stops.map((x) => ({ value: x.id, label: `${x.route} · ${x.name}` }))} />
        </Form.Item>
        <Form.Item name="dropStopId" label="Afternoon drop stop (half the slab fare)">
          <Select allowClear showSearch optionFilterProp="label" placeholder="None" options={stops.map((x) => ({ value: x.id, label: `${x.route} · ${x.name}` }))} />
        </Form.Item>
        <Form.Item name="routeId" label="Or a flat-fee route (instead of stops)">
          <Select allowClear placeholder="None" options={routes.map((r) => ({ value: r.id, label: r.name }))} />
        </Form.Item>
        <Form.Item name="roomId" label="Hostel room">
          <Select allowClear placeholder="None" options={rooms.map((r) => ({ value: r.id, label: r.name }))} />
        </Form.Item>
      </Form>
    </Modal>
  )
}
