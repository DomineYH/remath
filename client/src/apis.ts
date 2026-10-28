// 실마다 Api 인스턴스 하나(C-11). 화면은 여기서만 가져다 쓴다.
import { createApi } from './api/index.ts';

export const teacherApi = createApi('teacher');
export const adminApi = createApi('admin');
