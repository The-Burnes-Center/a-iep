import re
from typing import Dict, Callable, Tuple, Any
from functools import wraps

class RouteNotFoundException(Exception):
    """Exception raised when no matching route is found."""
    pass

def route(path: str, method: str):
    """Decorator to register routes with their handlers."""
    def decorator(func: Callable):
        @wraps(func)
        def wrapper(*args, **kwargs):
            return func(*args, **kwargs)
        wrapper.path = path
        wrapper.method = method
        return wrapper
    return decorator

class Router:
    """Router for handling API requests.

    Built once per container and reused. It logs nothing: a request is one
    line, written by lambda_handler with the route template, never the raw
    path (which carries a child's id).
    """
    def __init__(self):
        self.routes = {}
        self._patterns = {}

    def add_route(self, path: str, method: str, handler: Callable):
        """Register a new route with its handler."""
        if path not in self.routes:
            self.routes[path] = {}
            self._patterns[path] = self._path_to_pattern(path)
        self.routes[path][method] = handler

    def resolve(self, path: str, method: str) -> Tuple[str, Callable, Dict[str, Any]]:
        """Match a path and method: (route template, handler, path params)."""
        for route_path, pattern in self._patterns.items():
            match = pattern.match(path)
            if match and method in self.routes[route_path]:
                return route_path, self.routes[route_path][method], match.groupdict()
        raise RouteNotFoundException(f"No route found for {method} {path}")

    def match_route(self, path: str, method: str) -> Tuple[Callable, Dict[str, Any]]:
        """Match a path and method to a registered route."""
        _, handler, params = self.resolve(path, method)
        return handler, params

    def _path_to_pattern(self, path: str) -> re.Pattern:
        """Convert a path template to a regex pattern."""
        pattern = re.sub(r'{([^/]+)}', r'(?P<\1>[^/]+)', path)
        return re.compile(f'^{pattern}$')

class UserProfileRouter:
    """Router for user profile related endpoints."""
    
    @route('/profile', 'GET')
    def get_user_profile(self, event: Dict) -> Dict:
        from lambda_function import get_user_profile
        return get_user_profile(event)
    
    @route('/profile', 'PUT')
    def update_user_profile(self, event: Dict) -> Dict:
        from lambda_function import update_user_profile
        return update_user_profile(event)
    
    @route('/profile/children', 'POST')
    def add_child(self, event: Dict) -> Dict:
        from lambda_function import add_child
        return add_child(event)
    
    @route('/profile/children/{childId}/documents', 'GET')
    def get_child_documents(self, event: Dict) -> Dict:
        from lambda_function import get_child_documents
        return get_child_documents(event)
    
    @route('/profile/children/{childId}/documents', 'DELETE')
    def delete_child_documents(self, event: Dict) -> Dict:
        from lambda_function import delete_child_documents
        return delete_child_documents(event)
    
    @route('/profile', 'DELETE')
    def delete_user_profile(self, event: Dict) -> Dict:
        from lambda_function import delete_user_profile
        return delete_user_profile(event) 