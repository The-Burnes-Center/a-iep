import React, { useContext, useRef, useState } from 'react';
import {
  Container,
  Table,
  Button,
  Form,
  Row,
  Col,
  Alert,
  Spinner,
  Modal,
  Badge,
} from 'react-bootstrap';
import { Navigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { saveAs } from 'file-saver';
import { QRCodeCanvas } from 'qrcode.react';
import { AppContext } from '../../common/app-context';
import { ApiClient } from '../../common/api-client/api-client';
import { AdminUser, ReferralLink } from '../../common/types';
import { useAdminIdentity } from '../../common/helpers/use-admin-identity';
import MobileTopNavigation from '../../components/MobileTopNavigation';

const CHANNELS = ['social', 'conference', 'event', 'print', 'partner', 'other'];
const CODE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/**
 * Internal referral console, deliberately English-only and unlinked from any
 * navigation: admins visit /admin/referrals directly. The backend enforces
 * the Cognito 'admin' group on every /referral/admin route; the client-side
 * gate below only keeps non-admins from staring at an empty shell.
 */
export default function AdminReferrals() {
  const appContext = useContext(AppContext);
  const apiClient = new ApiClient(appContext);
  const queryClient = useQueryClient();

  const { isAdmin, sub, username } = useAdminIdentity();
  const [typeFilter, setTypeFilter] = useState<'all' | 'campaign' | 'user'>('all');
  const [qrLink, setQrLink] = useState<ReferralLink | null>(null);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [form, setForm] = useState({ code: '', name: '', channel: 'social', notes: '' });
  const [adminIdentifier, setAdminIdentifier] = useState('');
  const [adminError, setAdminError] = useState<string | null>(null);
  const qrWrapRef = useRef<HTMLDivElement>(null);

  const { data: links, isLoading, error } = useQuery({
    queryKey: ['referral', 'admin', 'links'],
    queryFn: () => apiClient.referral.adminListLinks(),
    enabled: isAdmin === true,
  });

  const createMutation = useMutation({
    mutationFn: () =>
      apiClient.referral.adminCreateLink({
        code: form.code.trim().toLowerCase(),
        name: form.name,
        channel: form.channel,
        notes: form.notes,
      }),
    onSuccess: () => {
      setForm({ code: '', name: '', channel: 'social', notes: '' });
      setCreateError(null);
      queryClient.invalidateQueries({ queryKey: ['referral', 'admin', 'links'] });
    },
    onError: (err: Error) => setCreateError(err.message),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ code, active }: { code: string; active: boolean }) =>
      apiClient.referral.adminUpdateLink(code, { active }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['referral', 'admin', 'links'] }),
  });

  const { data: admins, isLoading: adminsLoading } = useQuery({
    queryKey: ['referral', 'admin', 'admins'],
    queryFn: () => apiClient.referral.adminListAdmins(),
    enabled: isAdmin === true,
  });

  const addAdminMutation = useMutation({
    mutationFn: () => apiClient.referral.adminAddAdmin(adminIdentifier.trim()),
    onSuccess: () => {
      setAdminIdentifier('');
      setAdminError(null);
      queryClient.invalidateQueries({ queryKey: ['referral', 'admin', 'admins'] });
    },
    onError: (err: Error) => setAdminError(err.message),
  });

  const removeAdminMutation = useMutation({
    mutationFn: (target: string) => apiClient.referral.adminRemoveAdmin(target),
    onSuccess: () => {
      setAdminError(null);
      queryClient.invalidateQueries({ queryKey: ['referral', 'admin', 'admins'] });
    },
    onError: (err: Error) => setAdminError(err.message),
  });

  if (isAdmin === null) {
    return (
      <Container className="text-center mt-5">
        <Spinner animation="border" role="status" />
      </Container>
    );
  }
  if (isAdmin === false) {
    return <Navigate to="/account-center" replace />;
  }

  const linkUrl = (code: string) => `${window.location.origin}/r/${code}`;
  const conversion = (link: ReferralLink) =>
    link.clicks > 0 ? `${Math.round((link.signups / link.clicks) * 100)}%` : '-';

  const visibleLinks = (links || []).filter(
    (link) => typeFilter === 'all' || link.type === typeFilter
  );

  const handleCreate = (event: React.FormEvent) => {
    event.preventDefault();
    const code = form.code.trim().toLowerCase();
    if (!CODE_PATTERN.test(code)) {
      setCreateError('Code must be 1-32 characters: lowercase letters, digits, hyphens.');
      return;
    }
    createMutation.mutate();
  };

  const isSelf = (admin: AdminUser) =>
    admin.username === username || (!!admin.sub && admin.sub === sub);

  const handleRemoveAdmin = (admin: AdminUser) => {
    const label = admin.name || admin.phone || admin.email || admin.username;
    if (window.confirm(`Remove ${label} from the admin group?`)) {
      removeAdminMutation.mutate(admin.username);
    }
  };

  const handleCopy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(linkUrl(code));
      setCopiedCode(code);
      setTimeout(() => setCopiedCode(null), 1500);
    } catch {
      // ignore; row shows the code, admins can copy manually
    }
  };

  const downloadQr = (code: string) => {
    const canvas = qrWrapRef.current?.querySelector('canvas');
    canvas?.toBlob((blob) => blob && saveAs(blob, `aiep-qr-${code}.png`));
  };

  const exportCsv = () => {
    const escape = (value: unknown) => {
      const str = String(value ?? '');
      return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };
    const header = 'code,type,name,channel,active,clicks,signups,conversion,createdAt,url';
    const rows = (links || []).map((link) =>
      [
        link.code,
        link.type,
        escape(link.name),
        link.channel ?? '',
        link.active,
        link.clicks,
        link.signups,
        conversion(link),
        link.createdAt ?? '',
        linkUrl(link.code),
      ].join(',')
    );
    const stamp = new Date().toISOString().slice(0, 10);
    saveAs(
      new Blob([[header, ...rows].join('\n')], { type: 'text/csv;charset=utf-8' }),
      `aiep-referrals-${stamp}.csv`
    );
  };

  return (
    <>
      <MobileTopNavigation />
      <Container className="py-4" style={{ maxWidth: 1000 }}>
        <div className="d-flex justify-content-between align-items-center mb-3">
          <h4 className="mb-0 text-start">Referral links</h4>
          <Button variant="outline-secondary" size="sm" onClick={exportCsv} disabled={!links?.length}>
            <i className="bi bi-download me-1"></i>Export CSV
          </Button>
        </div>

        <Form onSubmit={handleCreate} className="border rounded p-3 mb-4 text-start">
          <div className="fw-semibold mb-2">New campaign link</div>
          {createError && <Alert variant="danger" className="py-2">{createError}</Alert>}
          <Row className="g-2 align-items-end">
            <Col xs={12} md={3}>
              <Form.Label className="mb-1">Code</Form.Label>
              <Form.Control
                placeholder="conf-2026"
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value })}
                required
              />
            </Col>
            <Col xs={12} md={3}>
              <Form.Label className="mb-1">Name</Form.Label>
              <Form.Control
                placeholder="CEC conference booth"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </Col>
            <Col xs={6} md={2}>
              <Form.Label className="mb-1">Channel</Form.Label>
              <Form.Select
                value={form.channel}
                onChange={(e) => setForm({ ...form, channel: e.target.value })}
              >
                {CHANNELS.map((channel) => (
                  <option key={channel} value={channel}>{channel}</option>
                ))}
              </Form.Select>
            </Col>
            <Col xs={6} md={2}>
              <Form.Label className="mb-1">Notes</Form.Label>
              <Form.Control
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
              />
            </Col>
            <Col xs={12} md={2}>
              <Button type="submit" className="w-100" disabled={createMutation.isPending}>
                {createMutation.isPending ? 'Creating...' : 'Create'}
              </Button>
            </Col>
          </Row>
        </Form>

        <div className="d-flex align-items-center gap-2 mb-2">
          <Form.Select
            size="sm"
            style={{ width: 'auto' }}
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as 'all' | 'campaign' | 'user')}
          >
            <option value="all">All links</option>
            <option value="campaign">Campaign links</option>
            <option value="user">Personal (parent) links</option>
          </Form.Select>
          {isLoading && <Spinner animation="border" size="sm" />}
        </div>

        {error ? (
          <Alert variant="danger">Could not load links. Are you in the admin group?</Alert>
        ) : (
          <Table striped hover responsive size="sm" className="align-middle text-start">
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Channel</th>
                <th>Type</th>
                <th className="text-end">Clicks</th>
                <th className="text-end">Signups</th>
                <th className="text-end">Conv.</th>
                <th>Active</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visibleLinks.map((link) => (
                <tr key={link.code}>
                  <td><code>{link.code}</code></td>
                  <td>{link.type === 'user' ? <span className="text-muted">parent code</span> : link.name}</td>
                  <td>{link.channel && <Badge bg="light" text="dark">{link.channel}</Badge>}</td>
                  <td>{link.type}</td>
                  <td className="text-end">{link.clicks}</td>
                  <td className="text-end">{link.signups}</td>
                  <td className="text-end">{conversion(link)}</td>
                  <td>
                    <Form.Check
                      type="switch"
                      checked={link.active}
                      onChange={(e) =>
                        toggleMutation.mutate({ code: link.code, active: e.target.checked })
                      }
                      aria-label={`Toggle ${link.code}`}
                    />
                  </td>
                  <td className="text-nowrap">
                    <Button
                      variant="link"
                      size="sm"
                      className="p-1"
                      onClick={() => handleCopy(link.code)}
                      title="Copy link"
                    >
                      <i className={`bi ${copiedCode === link.code ? 'bi-check-lg text-success' : 'bi-clipboard'}`}></i>
                    </Button>
                    <Button
                      variant="link"
                      size="sm"
                      className="p-1"
                      onClick={() => setQrLink(link)}
                      title="QR code"
                    >
                      <i className="bi bi-qr-code"></i>
                    </Button>
                  </td>
                </tr>
              ))}
              {!isLoading && visibleLinks.length === 0 && (
                <tr>
                  <td colSpan={9} className="text-center text-muted py-4">No links yet.</td>
                </tr>
              )}
            </tbody>
          </Table>
        )}

        <div className="d-flex justify-content-between align-items-center mt-5 mb-3">
          <h4 className="mb-0 text-start">Admins</h4>
          {adminsLoading && <Spinner animation="border" size="sm" />}
        </div>

        <Form
          className="border rounded p-3 mb-3 text-start"
          onSubmit={(e) => {
            e.preventDefault();
            if (adminIdentifier.trim()) addAdminMutation.mutate();
          }}
        >
          <div className="fw-semibold mb-2">Add an admin</div>
          {adminError && <Alert variant="danger" className="py-2">{adminError}</Alert>}
          <Row className="g-2 align-items-end">
            <Col xs={12} md={6}>
              <Form.Label className="mb-1">Phone number or email</Form.Label>
              <Form.Control
                placeholder="+1 555 123 4567 or name@example.org"
                value={adminIdentifier}
                onChange={(e) => setAdminIdentifier(e.target.value)}
                required
              />
            </Col>
            <Col xs={12} md={2}>
              <Button type="submit" className="w-100" disabled={addAdminMutation.isPending}>
                {addAdminMutation.isPending ? 'Adding...' : 'Add'}
              </Button>
            </Col>
          </Row>
          <div className="form-text">
            The account must already exist in the app. New admins pick up access
            on their next sign-in.
          </div>
        </Form>

        <Table striped hover responsive size="sm" className="align-middle text-start">
          <thead>
            <tr>
              <th>Name</th>
              <th>Phone</th>
              <th>Email</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(admins || []).map((admin) => (
              <tr key={admin.username}>
                <td>
                  {admin.name || <span className="text-muted">-</span>}
                  {isSelf(admin) && <Badge bg="secondary" className="ms-2">you</Badge>}
                </td>
                <td>{admin.phone || '-'}</td>
                <td>{admin.email || '-'}</td>
                <td>{admin.status}</td>
                <td className="text-end">
                  <Button
                    variant="link"
                    size="sm"
                    className="p-1 text-danger"
                    onClick={() => handleRemoveAdmin(admin)}
                    disabled={isSelf(admin) || removeAdminMutation.isPending}
                    title={isSelf(admin) ? 'You cannot remove yourself' : 'Remove admin'}
                  >
                    <i className="bi bi-person-dash"></i>
                  </Button>
                </td>
              </tr>
            ))}
            {!adminsLoading && (admins || []).length === 0 && (
              <tr>
                <td colSpan={5} className="text-center text-muted py-4">No admins found.</td>
              </tr>
            )}
          </tbody>
        </Table>
      </Container>

      <Modal show={qrLink !== null} onHide={() => setQrLink(null)} centered>
        <Modal.Header closeButton>
          <Modal.Title>{qrLink?.name || qrLink?.code}</Modal.Title>
        </Modal.Header>
        <Modal.Body className="text-center" ref={qrWrapRef}>
          {qrLink && (
            <>
              <QRCodeCanvas value={linkUrl(qrLink.code)} size={240} marginSize={2} />
              <div className="mt-3"><code>{linkUrl(qrLink.code)}</code></div>
            </>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outline-secondary" onClick={() => qrLink && downloadQr(qrLink.code)}>
            <i className="bi bi-download me-1"></i>Download PNG
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  );
}
