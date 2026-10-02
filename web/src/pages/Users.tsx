import { Button, Form, Input, Modal, Select, Switch, Table, Tag, message } from 'antd'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { useSelection } from '../selection'

type User = { id: number; username: string; role: string; schoolId: number | null; active: boolean; school: { name: string } | null }

const roles = ['ADMIN', 'ACCOUNTANT', 'VIEWER', 'SUPERADMIN'].map((r) => ({ value: r, label: r }))

// ponytail: API enforces who may grant what; UI shows all roles and surfaces the 400/403.
export default function Users() {
  const { schools } = useSelection()
  const [rows, setRows] = useState<User[]>([])
  const [editing, setEditing] = useState<User | 'new' | null>(null)
  const [form] = Form.useForm()
  const role = Form.useWatch('role', form)

  const load = () => api<User[]>('/users').then(setRows).catch((e) => message.error(e.message))
  useEffect(() => {
    load()
  }, [])

  function open(u: User | 'new') {
    setEditing(u)
    form.resetFields()
    if (u !== 'new') form.setFieldsValue({ ...u, password: undefined })
  }

  async function save(values: Record<string, unknown>) {
    if (!values.password) delete values.password
    try {
      if (editing === 'new') await api('/users', { method: 'POST', body: JSON.stringify(values) })
      else await api(`/users/${editing!.id}`, { method: 'PATCH', body: JSON.stringify(values) })
      setEditing(null)
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  return (
    <>
      <Button type="primary" onClick={() => open('new')} style={{ marginBottom: 16 }}>
        Add user
      </Button>
      <Table rowKey="id" dataSource={rows} pagination={false} scroll={{ x: true }} columns={[
        { title: 'Username', dataIndex: 'username' },
        { title: 'Role', dataIndex: 'role' },
        { title: 'School', render: (_, u) => u.school?.name ?? 'All schools' },
        { title: 'Status', render: (_, u) => (u.active ? <Tag color="green">Active</Tag> : <Tag>Disabled</Tag>) },
        { title: '', render: (_, u) => <Button size="small" onClick={() => open(u)}>Edit</Button> },
      ]} />
      <Modal title={editing === 'new' ? 'Add user' : 'Edit user'} open={!!editing} onCancel={() => setEditing(null)} onOk={() => form.submit()}>
        <Form form={form} layout="vertical" onFinish={save} initialValues={{ role: 'ACCOUNTANT', active: true }}>
          <Form.Item name="username" label="Username" rules={[{ required: true, pattern: /^[a-z0-9._-]{3,32}$/, message: '3-32 chars: a-z 0-9 . _ -' }]}>
            <Input autoComplete="off" />
          </Form.Item>
          <Form.Item name="role" label="Role" rules={[{ required: true }]}>
            <Select options={roles} />
          </Form.Item>
          {role !== 'SUPERADMIN' && (
            <Form.Item name="schoolId" label="School" rules={[{ required: true }]}>
              <Select options={schools.map((s) => ({ value: s.id, label: s.name }))} />
            </Form.Item>
          )}
          <Form.Item name="password" label={editing === 'new' ? 'Password' : 'New password (leave blank to keep)'}
            rules={[{ required: editing === 'new', min: 8 }]}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          {editing !== 'new' && (
            <Form.Item name="active" label="Active" valuePropName="checked">
              <Switch />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </>
  )
}
