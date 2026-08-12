import * as React from "react";
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { v4 as uuidv4 } from 'uuid';

/**
 * Queue of transient messages raised from anywhere in the app. The rendering
 * lives in NotificationToasts, which app-configured mounts alongside this
 * provider and above <Routes>, so a message raised just before a navigation
 * still reaches the parent who triggered it.
 *
 * The severity used to be Cloudscape's FlashbarProps.Type. It is declared here
 * now so the queue owns its own contract: only 'success' and 'error' are
 * raised today, and the other two are listed because NotificationToasts has to
 * map every member to a role and a colour anyway.
 */
export type NotificationType = 'success' | 'error' | 'warning' | 'info';

export interface NotificationItem {
  id: string;
  type: NotificationType;
  content: React.ReactNode;
}

interface NotificationContextValue {
  notifications: NotificationItem[];
  addNotification: (type: NotificationType, content: React.ReactNode) => string;
  removeNotification: (id: string) => void;
}

// Create a context for the notification manager
// eslint-disable-next-line react-refresh/only-export-components -- the context object has to live beside its provider so consumers can import both from one place
export const NotificationContext = createContext<NotificationContextValue>({
  notifications: [],
  addNotification: () => '',
  removeNotification: () => {}
});

export const NotificationProvider = ({ children }: { children: React.ReactNode }) => {
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);

  // Both callbacks are stable so a toast's auto-dismiss timer is not restarted
  // every time a sibling notification arrives or leaves.
  const removeNotification = useCallback((id: string) => {
    setNotifications(prev => prev.filter(notification => notification.id !== id));
  }, []);

  const addNotification = useCallback((type: NotificationType, content: React.ReactNode): string => {
    const id = uuidv4();
    setNotifications(prev => [...prev, { id, type, content }]);
    return id;
  }, []);

  const value = useMemo(
    () => ({ notifications, addNotification, removeNotification }),
    [notifications, addNotification, removeNotification]
  );

  return (
    <NotificationContext.Provider value={value}>
      {children}
    </NotificationContext.Provider>
  );
};

// eslint-disable-next-line react-refresh/only-export-components -- convenience hook over NotificationContext; splitting it into its own file would churn every consumer import
export const useNotifications = () => useContext(NotificationContext);
