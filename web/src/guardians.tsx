import { Button, Checkbox, Divider, Form, Input, Modal, Popconfirm, Select, Space, Table, message } from 'antd'
import { useEffect, useState } from 'react'
import { Gate } from './session'
import { api } from './api'

type Guardian = {
  id: number; name: string; relation: string; mobile?: string; email?: string; designation?: string; organization?: string
  officeAddress?: string; officePhone?: string; occupationId?: number; isStaff: boolean; staffBranch?: string
}
type Subject = { id: number; name: string; kind: string }
const relations = ['FATHER', 'MOTHER', 'GUARDIAN'].map((v) => ({ value: v, label: v[0] + v.slice(1).toLowerCase() }))

// Parents/guardians (CRUD) and the student's language/additional subjects for the selected year.
export function GuardiansModal({ student, schoolId, yearId, onClose }: {
  student: { id: number; name: string } | null; schoolId?: number; yearId?: number; onClose: () => void
}) {
  const [rows, setRows] = useState<Guardian[]>([])
  const [occupations, setOccupations] = useState<{ id: number; name: string }[]>([])
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [chosen, setChosen] = useState<number[]>([])
  const [editing, setEditing] = useState<Partial<Guardian> | null>(null)
  const [form] = Form.useForm()
  const err = (e: Error) => message.error(e.message)

  const loadGuardians = () => api<Guardian[]>(`/students/${student!.id}/guardians`).then(setRows).catch(err)
  useEffect(() => {
    if (!student || !schoolId || !yearId) return
    loadGuardians()
    Promise.all([
      api<typeof occupations>(`/occupations?schoolId=${schoolId}`), api<Subject[]>(`/subjects?schoolId=${schoolId}`),
      api<Subject[]>(`/students/${student.id}/subjects?yearId=${yearId}`),
    ]).then(([o, s, mine]) => {
      setOccupations(o)
      setSubjects(s)
      setChosen(mine.map((x) => x.id))
    }).catch(err)
  }, [student, schoolId, yearId])

  async function save(v: Record<string, unknown>) {
    const body = Object.fromEntries(Object.entries(v).filter(([, x]) => x !== '' && x !== null && x !== undefined))
    try {
      if (editing?.id) await api(`/guardians/${editing.id}`, { method: 'PATCH', body: JSON.stringify(body) })
      else await api(`/students/${student!.id}/guardians`, { method: 'POST', body: JSON.stringify(body) })
      setEditing(null)
      await loadGuardians()
    } catch (e) {
      err(e as Error)
    }
  }
  async function remove(id: number) {
    try {
      await api(`/guardians/${id}`, { method: 'DELETE' })
      await loadGuardians()
    } catch (e) {
      err(e as Error)
    }
  }
  async function saveSubjects() {
    try {
      await api(`/students/${student!.id}/subjects`, { method: 'PUT', body: JSON.stringify({ yearId, subjectIds: chosen }) })
      message.success('Subjects saved')
    } catch (e) {
      err(e as Error)
    }
  }

  return (
    <Modal title={`Guardians & subjects — ${student?.name ?? ''}`} open={!!student} onCancel={onClose} footer={null} width={760}>
      <Gate cap="guardians.write"><Button type="primary" style={{ marginBottom: 8 }} onClick={() => { form.resetFields(); form.setFieldsValue({ relation: 'FATHER', isStaff: false }); setEditing({}) }}>Add guardian</Button></Gate>
      <Table size="small" rowKey="id" dataSource={rows} pagination={false} scroll={{ x: true }} columns={[
        { title: 'Name', dataIndex: 'name' }, { title: 'Relation', dataIndex: 'relation' }, { title: 'Mobile', dataIndex: 'mobile' },
        { title: 'Occupation', render: (_, r) => occupations.find((o) => o.id === r.occupationId)?.name },
        { title: 'Staff', render: (_, r) => (r.isStaff ? `Yes${r.staffBranch ? ` (${r.staffBranch})` : ''}` : '') },
        { title: '', render: (_, r) => (
          <Space>
            <Gate cap="guardians.write" hide><Button size="small" onClick={() => { form.resetFields(); form.setFieldsValue(r); setEditing(r) }}>Edit</Button></Gate>
            <Gate cap="guardians.write" hide><Popconfirm title="Delete guardian?" onConfirm={() => remove(r.id)}><Button size="small" danger>Delete</Button></Popconfirm></Gate>
          </Space>
        ) },
      ]} />
      <Divider>Subjects this year</Divider>
      <Space.Compact style={{ width: '100%' }}>
        <Select mode="multiple" style={{ flex: 1 }} placeholder="Language / additional subjects" value={chosen} onChange={setChosen} optionFilterProp="label"
          options={subjects.map((s) => ({ value: s.id, label: `${s.name} (${s.kind.toLowerCase()})` }))} />
        <Gate cap="guardians.write"><Button type="primary" onClick={saveSubjects}>Save subjects</Button></Gate>
      </Space.Compact>

      <Modal title={editing?.id ? 'Edit guardian' : 'Add guardian'} open={!!editing} onCancel={() => setEditing(null)} onOk={() => form.submit()} destroyOnHidden>
        <Form form={form} layout="vertical" onFinish={save}>
          <Form.Item name="name" label="Name" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="relation" label="Relation" rules={[{ required: true }]}><Select options={relations} /></Form.Item>
          <Form.Item name="mobile" label="Mobile"><Input type="tel" /></Form.Item>
          <Form.Item name="email" label="Email" rules={[{ type: 'email' }]}><Input type="email" /></Form.Item>
          <Form.Item name="occupationId" label="Occupation">
            <Select allowClear showSearch optionFilterProp="label" options={occupations.map((o) => ({ value: o.id, label: o.name }))} />
          </Form.Item>
          <Form.Item name="designation" label="Designation"><Input /></Form.Item>
          <Form.Item name="organization" label="Organization"><Input /></Form.Item>
          <Form.Item name="officeAddress" label="Office address"><Input /></Form.Item>
          <Form.Item name="officePhone" label="Office phone"><Input type="tel" /></Form.Item>
          <Form.Item name="isStaff" valuePropName="checked"><Checkbox>Works at this school (staff ward)</Checkbox></Form.Item>
          <Form.Item name="staffBranch" label="Staff branch"><Input /></Form.Item>
        </Form>
      </Modal>
    </Modal>
  )
}
