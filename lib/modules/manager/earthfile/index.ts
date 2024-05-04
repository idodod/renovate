import type { Category } from '../../../constants';
import { DockerDatasource } from '../../datasource/docker';
import { extractPackageFile } from './extract';

export { extractPackageFile };

export const defaultConfig = {
  fileMatch: ['(^|/)Earthfile$', '(^|/|).+?\\.earth$'],
};

export const categories: Category[] = ['docker'];

export const supportedDatasources = [DockerDatasource.id];
