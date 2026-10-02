import {
  Button, Checkbox, Drawer, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Switch, Table, Tag, message,
} from 'antd'
import { useEffect, useState } from 'react'
import { api, openPdf } from '../api'
import { useSelection } from '../selection'
import { BillView, type Bill } from '../bill'
import { ConcessionsModal } from '../concessions'
import { FacilitiesModal } from '../facilities'
import { FinesModal } from '../fines'
import { WithdrawModal } from '../withdrawal'

type Standard = { id: number; name: string; sections: { id: number; name: string }[] }
type FeeHead = { id: number; name: string; type: string }
type Student = {
  id: number; admissionNo: string; name: string; fatherName?: string; motherName?: string; phone?: string; email?: string; active: boolean
  enrollment: { sectionId: number; standardId: number; className: string; rollNo?: number; isNewAdmission: boolean; optionalHeadIds: number[] }
}
export default function Students() {
  const { schoolId, yearId } = useSelection()
  const [rows, setRows] = useState<Student[]>([])
  const [standards, setStandards] = useState<Standard[]>([])
  const [heads, setHeads] = useState<FeeHead[]>([])
  const optionalHeads = heads.filter((x) => x.type === 'OPTIONAL')
  const [conc, setConc] = useState<Student | null>(null)
  const [fac, setFac] = useState<Student | null>(null)
  const [fine, setFine] = useState<Student | null>(null)
  const [leaving, setLeaving] = useState<Student | null>(null)
  const [filter, setFilter] = useState<{ standardId?: number; q: string }>({ q: '' })
  const [editing, setEditing] = useState<Partial<Student> | null>(null)
  const [bill, setBill] = useState<(Bill & { id: number }) | null>(null)
  const [form] = Form.useForm()

  useEffect(() => {
    if (!schoolId) return
    Promise.all([api<Standard[]>(`/standards?schoolId=${schoolId}`), api<FeeHead[]>(`/fee-heads?schoolId=${schoolId}`)])
      .then(([s, h]) => {
        setStandards(s)
        setHeads(h)
      })
      .catch((e) => message.error(e.message))
  }, [schoolId])

  const load = async () => {
    if (!schoolId || !yearId) return
    const qs = new URLSearchParams({ schoolId: String(schoolId), yearId: String(yearId) })
    if (filter.standardId) qs.set('standardId', String(filter.standardId))
    if (filter.q) qs.set('q', filter.q)
    setRows(await api<Student[]>(`/students?${qs}`))
  }
  useEffect(() => {
    load().catch((e) => message.error(e.message))
  }, [schoolId, yearId, filter])

  const sectionOptions = standards.flatMap((s) => s.sections.map((sec) => ({ value: sec.id, label: `${s.name} ${sec.name}` })))

  function open(s?: Student) {
    form.resetFields()
    form.setFieldsValue(s ? { ...s, ...s.enrollment } : { isNewAdmission: true, optionalHeadIds: [] })
    setEditing(s ?? {})
  }

  async function save(values: Record<string, unknown>) {
    const body = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== '' && v !== null && v !== undefined))
    try {
      if (editing?.id) await api(`/students/${editing.id}`, { method: 'PATCH', body: JSON.stringify({ ...body, yearId }) })
      else await api('/students', { method: 'POST', body: JSON.stringify({ ...body, schoolId, yearId }) })
      setEditing(null)
      await load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  async function readmit(id: number) {
    try {
      await api(`/students/${id}/withdrawal?yearId=${yearId}`, { method: 'DELETE' })
      message.success('Student re-admitted')
      await load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  async function showBill(id: number) {
    try {
      setBill({ ...(await api<Bill>(`/students/${id}/bill?yearId=${yearId}`)), id })
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  return (
    <>
      <Space wrap style={{ marginBottom: 16 }}>
        <Button type="primary" onClick={() => open()}>Admit student</Button>
        <Select allowClear placeholder="All classes" style={{ minWidth: 160 }} value={filter.standardId}
          onChange={(standardId) => setFilter((f) => ({ ...f, standardId }))}
          options={standards.map((s) => ({ value: s.id, label: s.name }))} />
        <Input.Search allowClear placeholder="Name or admission no." style={{ width: 240 }}
          onSearch={(q) => setFilter((f) => ({ ...f, q }))} />
      </Space>
      <Table rowKey="id" dataSource={rows} scroll={{ x: true }} pagination={{ pageSize: 25 }} columns={[
        { title: 'Adm. no.', dataIndex: 'admissionNo' },
        { title: 'Name', dataIndex: 'name', render: (v, r) => <>{v} {!r.active && <Tag color="red">Inactive</Tag>}</> },
        { title: 'Class', render: (_, r) => r.enrollment.className },
        { title: 'Roll', render: (_, r) => r.enrollment.rollNo },
        { title: 'New', render: (_, r) => r.enrollment.isNewAdmission && <Tag color="blue">New</Tag> },
        {
          title: '',
          render: (_, r) => (
            <Space>
              <Button size="small" onClick={() => showBill(r.id)}>Bill</Button>
              <Button size="small" onClick={() => open(r)}>Edit</Button>
              <Button size="small" onClick={() => setConc(r)}>Concessions</Button>
              <Button size="small" onClick={() => setFine(r)}>Fines</Button>
              <Button size="small" onClick={() => setFac(r)}>Transport/Hostel</Button>
              {r.active ? (
                <Button size="small" danger onClick={() => setLeaving(r)}>Withdraw</Button>
              ) : (
                <>
                  <Button size="small" onClick={() => openPdf(`/students/${r.id}/withdrawal/pdf?yearId=${yearId}`).catch((e) => message.error(e.message))}>Slip</Button>
                  <Popconfirm title="Re-admit this student? Charges after the leaving date return." onConfirm={() => readmit(r.id)}>
                    <Button size="small">Re-admit</Button>
                  </Popconfirm>
                </>
              )}
            </Space>
          ),
        },
      ]} />

      <Modal title={editing?.id ? 'Edit student' : 'Admit student'} open={!!editing} onCancel={() => setEditing(null)} onOk={() => form.submit()} width={560}>
        <Form form={form} layout="vertical" onFinish={save}>
          <Form.Item name="admissionNo" label="Admission no." rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="name" label="Student name" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="sectionId" label="Class & section" rules={[{ required: true }]}>
            <Select options={sectionOptions} showSearch optionFilterProp="label" />
          </Form.Item>
          <Form.Item name="rollNo" label="Roll no."><InputNumber min={1} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="fatherName" label="Father's name"><Input /></Form.Item>
          <Form.Item name="motherName" label="Mother's name"><Input /></Form.Item>
          <Form.Item name="phone" label="Phone"><Input type="tel" /></Form.Item>
          <Form.Item name="email" label="Email" rules={[{ type: 'email' }]}><Input type="email" /></Form.Item>
          <Form.Item name="isNewAdmission" valuePropName="checked">
            <Checkbox>New admission (charged admission & refundable fees)</Checkbox>
          </Form.Item>
          {optionalHeads.length > 0 && (
            <Form.Item name="optionalHeadIds" label="Optional fees">
              <Checkbox.Group options={optionalHeads.map((h) => ({ value: h.id, label: h.name }))} />
            </Form.Item>
          )}
          {editing?.id && (
            <Form.Item name="active" label="Active" valuePropName="checked"><Switch /></Form.Item>
          )}
        </Form>
      </Modal>

      <Drawer title="Fee bill" open={!!bill} onClose={() => setBill(null)} size="large"
        extra={bill && <Button onClick={() => openPdf(`/students/${bill.id}/bill.pdf?yearId=${yearId}`).catch((e) => message.error(e.message))}>PDF</Button>}>
        {bill && (
          <BillView bill={bill} />
        )}
      </Drawer>
      <ConcessionsModal student={conc} yearId={yearId} heads={heads} onClose={() => setConc(null)} />
      <WithdrawModal student={leaving} yearId={yearId} onClose={() => setLeaving(null)} onDone={() => { setLeaving(null); load().catch((e) => message.error(e.message)) }} />
      <FinesModal student={fine} schoolId={schoolId} yearId={yearId} onClose={() => setFine(null)} />
      <FacilitiesModal student={fac} schoolId={schoolId} yearId={yearId} onClose={() => setFac(null)} />
    </>
  )
}
