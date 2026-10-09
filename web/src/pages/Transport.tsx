import { Button, Empty, Form, Input, InputNumber, Popconfirm, Select, Space, Table, Tabs, message } from 'antd'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { useSelection } from '../selection'
import { Gate, useCan } from '../session'
import { downloadCsv } from '../csv'
import FacilityPage from './Facility'

type Facility = { id: number; name: string }
type Stop = { id: number; routeId: number; name: string; sequence: number; pickupTime: string | null; dropTime: string | null; slabId: number; slab: string; route: string }
type Person = { id: number; admissionNo: string; name: string; className: string }
type BusList = { routeId: number; route: string; pickups: number; drops: number; stops: { stopId: number; sequence: number; name: string; slab: string; pickupTime: string | null; dropTime: string | null; pickup: Person[]; drop: Person[] }[] }

// A student's fare is half the stop's slab fee for each leg (morning pickup, afternoon drop).
export default function Transport() {
  return (
    <Tabs items={[
      { key: 'stops', label: 'Routes & stops', children: <Stops /> },
      { key: 'slabs', label: 'Slabs (fares)', children: <FacilityPage kind="SLAB" label="Slab" /> },
      { key: 'lists', label: 'Bus lists', children: <BusLists /> },
      { key: 'flat', label: 'Flat-fee routes', children: <FacilityPage kind="TRANSPORT" label="Route" /> },
    ]} />
  )
}

function Stops() {
  const { schoolId } = useSelection()
  const can = useCan()
  const [routes, setRoutes] = useState<Facility[]>([])
  const [slabs, setSlabs] = useState<Facility[]>([])
  const [routeId, setRouteId] = useState<number>()
  const [stops, setStops] = useState<Stop[]>([])
  const [newRoute, setNewRoute] = useState('')
  const [form] = Form.useForm()

  const loadRoutes = () => schoolId && Promise.all([
    api<Facility[]>(`/facilities?schoolId=${schoolId}&kind=TRANSPORT`), api<Facility[]>(`/facilities?schoolId=${schoolId}&kind=SLAB`),
  ]).then(([r, s]) => { setRoutes(r); setSlabs(s) }).catch((e) => message.error(e.message))
  const loadStops = () => schoolId && routeId
    ? api<Stop[]>(`/stops?schoolId=${schoolId}&routeId=${routeId}`).then(setStops).catch((e) => message.error(e.message))
    : setStops([])
  useEffect(() => { loadRoutes() }, [schoolId])
  useEffect(() => { loadStops() }, [schoolId, routeId])

  const run = async (p: Promise<unknown>) => {
    try { await p; await loadStops() } catch (e) { message.error((e as Error).message) }
  }
  async function addRoute() {
    if (!newRoute.trim()) return
    try {
      const r = await api<Facility>('/facilities', { method: 'POST', body: JSON.stringify({ schoolId, kind: 'TRANSPORT', name: newRoute.trim() }) })
      setNewRoute('')
      await loadRoutes()
      setRouteId(r.id)
    } catch (e) { message.error((e as Error).message) }
  }
  const addStop = (v: { name: string; sequence: number; slabId: number; pickupTime?: string; dropTime?: string }) =>
    run(api('/stops', { method: 'POST', body: JSON.stringify({ ...v, routeId, pickupTime: v.pickupTime || undefined, dropTime: v.dropTime || undefined }) }).then(() => form.resetFields()))

  return (
    <>
      <Space wrap style={{ marginBottom: 16 }}>
        <Select placeholder="Route" style={{ width: 200 }} value={routeId} onChange={setRouteId} options={routes.map((r) => ({ value: r.id, label: r.name }))} />
        {can('facilities.write') && <>
          <Input placeholder="New route name" value={newRoute} onChange={(e) => setNewRoute(e.target.value)} onPressEnter={addRoute} style={{ width: 180 }} />
          <Button onClick={addRoute}>Add route</Button>
        </>}
      </Space>
      {!routeId ? <Empty description="Pick or add a route" /> : (
        <>
          <Table rowKey="id" size="small" dataSource={stops} pagination={false} style={{ marginBottom: 16 }} columns={[
            { title: '#', dataIndex: 'sequence', width: 60 },
            { title: 'Stop', dataIndex: 'name' },
            { title: 'Slab', dataIndex: 'slab' },
            { title: 'Pickup', dataIndex: 'pickupTime' },
            { title: 'Drop', dataIndex: 'dropTime' },
            { title: '', render: (_: unknown, s: Stop) => (
              <Gate cap="stops.write" hide>
                <Popconfirm title="Delete this stop? (Refused if students use it.)" onConfirm={() => run(api(`/stops/${s.id}`, { method: 'DELETE' }))}>
                  <Button size="small" danger>Delete</Button>
                </Popconfirm>
              </Gate>
            ) },
          ]} />
          {can('stops.write') && <Form form={form} layout="inline" onFinish={addStop} initialValues={{ sequence: stops.length + 1 }}>
            <Form.Item name="sequence" rules={[{ required: true }]}><InputNumber min={1} placeholder="#" style={{ width: 70 }} /></Form.Item>
            <Form.Item name="name" rules={[{ required: true }]}><Input placeholder="Stop name" style={{ width: 200 }} /></Form.Item>
            <Form.Item name="slabId" rules={[{ required: true, message: 'Slab' }]}>
              <Select placeholder="Slab" style={{ width: 140 }} options={slabs.map((s) => ({ value: s.id, label: s.name }))} />
            </Form.Item>
            <Form.Item name="pickupTime" rules={[{ pattern: /^([01]?\d|2[0-3]):[0-5]\d$/, message: 'HH:MM' }]}><Input placeholder="Pickup HH:MM" style={{ width: 120 }} /></Form.Item>
            <Form.Item name="dropTime" rules={[{ pattern: /^([01]?\d|2[0-3]):[0-5]\d$/, message: 'HH:MM' }]}><Input placeholder="Drop HH:MM" style={{ width: 120 }} /></Form.Item>
            <Button type="primary" htmlType="submit">Add stop</Button>
          </Form>}
        </>
      )}
    </>
  )
}

function BusLists() {
  const { schoolId, yearId } = useSelection()
  const [routes, setRoutes] = useState<BusList[]>([])

  useEffect(() => {
    if (schoolId && yearId) api<BusList[]>(`/reports/transport?schoolId=${schoolId}&yearId=${yearId}`).then(setRoutes).catch((e) => message.error(e.message))
  }, [schoolId, yearId])

  const csv = () => downloadCsv('bus-lists', ['Route', 'Stop #', 'Stop', 'Leg', 'Adm. no.', 'Student', 'Class'],
    routes.flatMap((r) => r.stops.flatMap((s) => [
      ...s.pickup.map((p) => [r.route, s.sequence, s.name, 'Pickup', p.admissionNo, p.name, p.className]),
      ...s.drop.map((p) => [r.route, s.sequence, s.name, 'Drop', p.admissionNo, p.name, p.className]),
    ])))

  if (!routes.length) return <Empty description="No routes with stops yet" />
  return (
    <>
      <Button onClick={csv} style={{ marginBottom: 16 }}>CSV</Button>
      {routes.map((r) => (
        <Table key={r.routeId} rowKey="stopId" size="small" bordered pagination={false} style={{ marginBottom: 24 }}
          title={() => <b>{r.route} · {r.pickups} pickup / {r.drops} drop</b>} dataSource={r.stops} columns={[
            { title: '#', dataIndex: 'sequence', width: 50 },
            { title: 'Stop', render: (_: unknown, s) => `${s.name} (${s.slab})` },
            { title: 'Morning pickup', render: (_: unknown, s) => s.pickup.map((p) => `${p.name} (${p.className})`).join(', ') },
            { title: 'Afternoon drop', render: (_: unknown, s) => s.drop.map((p) => `${p.name} (${p.className})`).join(', ') },
          ]} />
      ))}
    </>
  )
}
